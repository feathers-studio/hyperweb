import { version } from "../package.json";

import { URL } from "node:url";
import { Readable } from "node:stream";

import { WritableStream } from "htmlparser2/lib/WritableStream";
import { Err, matchDomain, trya } from "./util";
import type { Storage } from "./store";
import { parseExtension, type RawWebmentionWithPossiblePayload } from "./extensions";

type FormDataEntryValue = ReturnType<FormData["get"]>;

function parseURL(url: FormDataEntryValue, name: string, acceptedProtocols: string[]): URL | Err {
	if (!url) return new Err(`Missing ${name} URL`, 400);
	if (typeof url !== "string") return new Err(`${name} is not a string`, 400);

	try {
		const u = new URL(url);
		if (!acceptedProtocols.includes(u.protocol)) return new Err(`Unsupported ${name} protocol`, 400);
		return u;
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

export function Receiver(
	storage: Storage,
	options?: {
		/**
		 * @abstract "Senders MAY customize the HTTP User Agent [RFC7231] used when fetching the target URL..."
		 * @abstract "In this case, it is recommended to include the string "Webmention" in the User Agent."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-7
		 *
		 * @default "HyperWeb WebmentionReceiver/${version}"
		 */
		userAgent?: string;

		/**
		 * An extension to the Webmention specification that allows receivers to require a custom attribute to look for in `<a>`, `<img>`, `<audio>`, and `<video>` tags in the source document.
		 * @default "webmention"
		 */
		requireAttribute?: string;

		/**
		 * @abstract "The receiver MUST check that source and target are valid URLs [URL] and are of schemes that are supported by the receiver. (Most commonly this means checking that the source and target schemes are http or https)."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#request-verification-p-1
		 * @default ["http:", "https:"]
		 */
		acceptedProtocols?: string[];

		/**
		 * If set, the receiver will only accept Webmentions for the specified domains.
		 * @abstract "some receivers may accept Webmentions for multiple domains, others may accept Webmentions for only the same domain the endpoint is on."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#request-verification-p-3
		 */
		acceptedTargetDomains?: string[];

		/**
		 * If set, the receiver will only accept Webmentions for the specified content types.
		 * @abstract "The receiver SHOULD use per-media-type rules to determine whether the source document mentions the target URL."
		 * @abstract "content types may be handled at the implementer's discretion"
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#webmention-verification-p-3
		 * @default ["text/html", "application/json", "text/plain"]
		 */
		acceptedContentTypes?: string[];

		/**
		 * A function that checks if the body of a custom content type is valid.
		 * By default, the receiver will only accept Webmentions for "text/html", "application/json", and "text/plain" bodies.
		 */
		checkCustomContentTypeBody?: (request: Request, contentType: string | null) => Promise<boolean>;
	},
) {
	const userAgent = options?.userAgent ?? `HyperWeb WebmentionReceiver/${version}`;
	const requireAttribute = options?.requireAttribute ?? "webmention";
	const acceptedProtocols = options?.acceptedProtocols ?? ["http:", "https:"];
	const acceptedContentTypes = options?.acceptedContentTypes ?? ["text/html", "application/json", "text/plain"];
	const checkCustomContentTypeBody = options?.checkCustomContentTypeBody;

	return async function receiver(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("WebMention Request must be POST", { status: 405 });
		if (request.body === null) return new Response("Request body must not be null", { status: 400 });
		if (request.headers.get("Content-Type") !== "application/x-www-form-urlencoded")
			return new Response("Content-Type must be application/x-www-form-urlencoded", { status: 400 });

		const body = await trya(
			async () => new URLSearchParams(await request.text()),
			() => new Err("Malformed payload. Could not parse request body", 400),
		);

		if (body instanceof Err) return body;

		const mention = Object.fromEntries(body.entries());

		/**
		 * @abstract "The receiver MUST check that source and target are valid URLs [URL] and are of schemes that are supported by the receiver."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#request-verification-p-1
		 */

		const source = parseURL(mention.source, "source", acceptedProtocols);
		if (source instanceof Err) return source;

		const target = parseURL(mention.target, "target", acceptedProtocols);
		if (target instanceof Err) return target;

		if (mention.definition) {
			const extension = parseExtension(mention as RawWebmentionWithPossiblePayload);
			if (extension instanceof Err) return extension;
		}

		/**
		 * @abstract "The receiver MUST reject the request if the source URL is the same as the target URL."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#request-verification-p-2
		 */
		const sourceEqualsTarget = source.href === target.href;
		if (sourceEqualsTarget) return new Err("Source and target are the same", 400);

		if (options?.acceptedTargetDomains) {
			/**
			 * @abstract "some receivers may accept Webmentions for multiple domains, others may accept Webmentions for only the same domain the endpoint is on."
			 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#request-verification-p-3
			 */
			const supported = options.acceptedTargetDomains.some(domain => matchDomain(domain, target.hostname));
			if (!supported) return new Err("Receiver does not support target domain", 400);
		}

		// TODO: From this point on should be asynchronously put in a queue and processed in order

		/**
		 * @abstract "[the receiver] MUST perform an HTTP GET request on source, following any HTTP redirects"
		 * @abstract "The receiver SHOULD include an HTTP Accept header indicating its preference of content types that are acceptable."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#webmention-verification-p-2
		 */
		const response = await trya(
			() =>
				fetch(source.href, {
					method: "GET",
					redirect: "follow",
					headers: { "User-Agent": userAgent, "Accept": acceptedContentTypes.join(", ") },
				}),
			() => new Err("Failed to fetch source", 500),
		);

		if (response instanceof Err) return response;

		if (response.status === 410) {
			// TODO: Delete Webmention if it exists
			return new Response("Gone. Deleted Webmention");
		}

		if (!response.ok) {
			const text = await trya(
				() => response.text(),
				() => response.statusText,
			);

			const msg = `Failed to fetch source: ${response.status}\n${text}`;
			return new Err(msg, 400);
		}

		if (!response.body) return new Err("source response body is null", 400);

		const contentType = response.headers.get("Content-Type");

		if (contentType === "text/html") {
			const body = response.body;
			/**
			 * @abstract "in an [ HTML5] document, the receiver should look for <a href="*">, <img href="*">, <video src="*"> and other similar links"
			 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#webmention-verification-p-3
			 */
			const valid = await trya(
				() => validateHTML(body, target, requireAttribute),
				() => new Err("Error parsing HTML body", 400),
			);
			if (valid instanceof Err) return valid;
			if (!valid) return new Err("HTML body does not contain target", 400);
		} else if (contentType === "application/json") {
			/**
			 * @abstract "In a JSON ([RFC7159]) document, the receiver should look for properties whose values are an exact match for the URL."
			 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#webmention-verification-p-3
			 */
			const check = await trya(
				() => validateJSON(response, target),
				() => new Err("Error parsing JSON body", 400),
			);
			if (check instanceof Err) return check;
			if (!check) return new Err("JSON body does not contain target", 400);
		} else if (contentType === "text/plain") {
			/**
			 * @abstract "If the document is plain text, the receiver should look for the URL by searching for the string."
			 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#webmention-verification-p-3
			 */
			const text = await trya(
				() => response.text(),
				() => new Err("Error parsing plain text body", 400),
			);
			if (text instanceof Err) return text;
			if (!text.includes(target.href)) return new Err("Plain text body does not contain target", 400);
		} else {
			/**
			 * @abstract "does not find a mention of target on source, it SHOULD delete the existing Webmention"
			 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#updating-existing-webmentions-li-4
			 */
			// TODO: Delete Webmention if it exists

			if (!checkCustomContentTypeBody) return new Err("Unsupported content type", 400);

			/**
			 * @abstract "Other content types may be handled at the implementer's discretion."
			 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#webmention-verification-p-3
			 */
			const check = await trya(
				() => checkCustomContentTypeBody(request, contentType),
				() => new Err("Error checking custom content type body", 400),
			);
			if (check instanceof Err) return check;
			if (!check) return new Err(`${contentType} body does not contain target`, 400);
		}

		// TODO: Create Webmention
		return new Response("OK", { status: 200 });
	};
}
