import { version } from "../package.json";

import { URL } from "node:url";
import { Readable } from "node:stream";

import { WritableStream } from "htmlparser2/lib/WritableStream";
import { Err, trya, trys } from "./utils";

type FormDataEntryValue = ReturnType<FormData["get"]>;

function parseURL(url: FormDataEntryValue, name: string): URL | Err {
	if (!url) return new Err(`Missing ${name} URL`, 400);
	if (typeof url !== "string") return new Err(`${name} is not a string`, 400);

	try {
		return new URL(url);
	} catch (e) {
		return new Err(`Invalid ${name} URL`, 400);
	}
}

const isObject = (val: unknown): val is Record<string, unknown> => typeof val === "object" && val !== null;

function checkObject(obj: unknown, target: string): boolean {
	if (!isObject(obj)) return false;

	for (const key in obj) {
		if (typeof obj[key] === "object" && obj[key] !== null) {
			if (checkObject(obj[key], target)) return true;
		} else if (obj[key] === target) {
			return true;
		}
	}

	return false;
}

async function validateHTML(body: ReadableStream, target: URL, requireAttribute: string): Promise<boolean> {
	let validated = false;
	const parser = new WritableStream({
		onopentag(name, attribs) {
			if (!(requireAttribute in attribs)) return;

			if (name === "a")
				if (attribs.href === target.href) {
					validated = true;
					return parser.end();
				}

			if (!["img", "audio", "video"].includes(name)) return;

			if (attribs.src === target.href) {
				validated = true;
				return parser.end();
			}
		},
	});

	const stream = Readable.fromWeb(body);
	stream.pipe(parser);

	await new Promise(resolve => parser.on("finish", resolve));
	return validated;
}

async function validateJSON(response: Response, target: URL): Promise<boolean> {
	const data = await response.json();

	if (Array.isArray(data)) {
		for (const item of data) if (checkObject(item, target.href)) return true;
	} else if (isObject(data)) return checkObject(data, target.href);

	return false;
}

export function Receiver(options?: {
	/**
	 * @abstract "Senders MAY customize the HTTP User Agent [RFC7231] used when fetching the target URL..."
	 * @abstract "In this case, it is recommended to include the string "Webmention" in the User Agent."
	 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-7
	 *
	 * @default "HyperWeb WebmentionReceiver/${version}"
	 */
	userAgent?: string;

	/**
	 * @default "webmention"
	 */
	requireAttribute?: string;
}) {
	const userAgent = options?.userAgent ?? `HyperWeb WebmentionReceiver/${version}`;
	const requireAttribute = options?.requireAttribute ?? "webmention";

	return async function receiver(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("WebMention Request must be POST", { status: 405 });
		if (request.body === null) return new Response("Request body must not be null", { status: 400 });
		if (request.headers.get("Content-Type") !== "application/x-www-form-urlencoded")
			return new Response("Content-Type must be application/x-www-form-urlencoded", { status: 400 });

		const body = await trya(
			() => request.formData(),
			() => new Err("Malformed payload. Could not parse request body", 400),
		);

		if (body instanceof Err) return body;

		const source = parseURL(body.get("source"), "source");
		if (source instanceof Err) return source;

		const target = parseURL(body.get("target"), "target");
		if (target instanceof Err) return target;

		const response = await trya(
			() => fetch(source.href, { redirect: "follow", headers: { "User-Agent": userAgent } }),
			() => new Err("Failed to fetch source", 500),
		);
		if (response instanceof Err) return response;

		if (!response.ok) {
			let text;

			try {
				text = await response.text();
			} catch (e) {
				text = response.statusText;
			}

			const msg = `Failed to fetch source: ${response.status}\n${text}`;
			return new Err(msg, 400);
		}

		if (!response.body) return new Err("source response body is null", 400);

		const contentType = response.headers.get("Content-Type");

		if (contentType === "text/html") {
			const body = response.body;
			const valid = await trya(
				() => validateHTML(body, target, requireAttribute),
				() => new Err("Error parsing HTML body", 400),
			);
			if (valid instanceof Err) return valid;
			if (!valid) return new Err("HTML body does not contain target", 400);
		} else if (contentType === "application/json") {
			const valid = await trya(
				() => validateJSON(response, target),
				() => new Err("Error parsing JSON body", 400),
			);
			if (valid instanceof Err) return valid;
			if (!valid) return new Err("JSON body does not contain target", 400);
		}

		return new Response("OK", { status: 200 });
	};
}
