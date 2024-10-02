import { version } from "../package.json";

import { URL } from "node:url";
import { Readable } from "node:stream";

import { WritableStream } from "htmlparser2/lib/WritableStream";

type CrossOriginPolicy = "same-origin" | "same-site" | "cross-origin";
const CROSS_ORIGIN_POLICY: CrossOriginPolicy = "cross-origin";

/**
 * @abstract "Senders MAY customize the HTTP User Agent [RFC7231] used when fetching the target URL..."
 * @abstract "In this case, it is recommended to include the string "Webmention" in the User Agent."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-7
 */
const USER_AGENT = "HyperWeb WebmentionSender/" + version;

namespace WebmentionEndpoint {
	export class Discovered {
		constructor(public endpoint: string) {}
	}

	export class Error {
		constructor(public message: string, public code?: number) {}
	}
}

type WebmentionEndpoint = WebmentionEndpoint.Discovered | WebmentionEndpoint.Error;

const relRegex = /rel="([^"]+)"/;

/**
 * @abstract "check for an HTTP Link header [RFC5988] with a rel value of webmention"
 * @abstract "the first HTTP Link header takes precedence"
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-1
 */
function tryParseWebmentionLinkHeader(response: Response): WebmentionEndpoint {
	const header = response.headers.get("link");
	if (!header) return new WebmentionEndpoint.Error("No Link header found", response.status);
	const links = header.split(",");

	for (const link of links) {
		const [urlpart, relpart] = link.split(";");
		if (urlpart[0] !== "<" || urlpart.slice(-1) !== ">") continue;
		if (!relRegex.test(relpart)) continue;
		const url = urlpart.slice(1, -1);
		const rel = relpart.match(relRegex)?.[1];
		if (rel !== "webmention") continue;
		return new WebmentionEndpoint.Discovered(url);
	}

	return new WebmentionEndpoint.Error("No webmention Link header found", response.status);
}

/**
 * @abstract "If the content type of the document is HTML, then the sender MUST look for an HTML `<link>` and `<a>` element with a rel value of webmention."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-1
 */
async function tryParseHTML(response: Response): Promise<WebmentionEndpoint> {
	if (!response.body) return new WebmentionEndpoint.Error("No body found", response.status);

	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("text/html"))
		return new WebmentionEndpoint.Error("Not an HTML document", response.status);

	let webmentionEndpoint: string | undefined;

	const parser = new WritableStream({
		onopentag(name, attribs) {
			if (name !== "link" && name !== "a") return;

			if (attribs.rel === "webmention") {
				webmentionEndpoint = attribs.href;
				parser.end();
			}
		},
	});

	const stream = Readable.fromWeb(response.body);
	stream.pipe(parser);

	await new Promise(resolve => parser.on("finish", resolve));

	if (webmentionEndpoint) return new WebmentionEndpoint.Discovered(webmentionEndpoint);
	return new WebmentionEndpoint.Error("No webmention Link header, <link> or <a> element found", response.status);
}

const f = (url: string, method: "HEAD" | "GET") =>
	fetch(url, {
		method,
		redirect: "follow",
		headers: { "User-Agent": USER_AGENT },
	});

/**
 *
 * @abstract "Senders MAY initially make an HTTP HEAD request [RFC7231] to check for the Link header before making a GET request."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-4
 */
async function tryHeadRequest(url: string): Promise<WebmentionEndpoint> {
	const response = await f(url, "HEAD");
	if (!response.ok) return new WebmentionEndpoint.Error(response.statusText, response.status);
	return tryParseWebmentionLinkHeader(response);
}

/**
 * @abstract "The sender MUST fetch the target URL (and follow redirects [FETCH])"
 * @abstract "If the content type of the document is HTML, then the sender MUST look for an HTML <link> and <a> element with a rel value of webmention."
 * @abstract "If more than one of these is present, the first HTTP Link header takes precedence, followed by the first `<link>` or `<a>` element in document order. Senders MUST support all three options and fall back in this order."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-1
 */
async function tryGetRequest(url: string): Promise<WebmentionEndpoint> {
	const response = await f(url, "GET");
	if (!response.ok) return new WebmentionEndpoint.Error(response.statusText, response.status);

	const webmentionEndpoint = tryParseWebmentionLinkHeader(response);
	if (webmentionEndpoint) return webmentionEndpoint;

	return tryParseHTML(response);
}

function crossOriginPolicyViolation(
	policy: CrossOriginPolicy,
	violation: "protocol" | "host" | "port",
	expected: string,
	found: string,
): WebmentionEndpoint.Error {
	return new WebmentionEndpoint.Error(
		`${policy} policy violation (${violation}): expected ${expected}, found ${found}`,
		500,
	);
}

// Normalise the hostnames by converting to lowercase and removing trailing dots
const normaliseHostname = (hostname: string) => hostname.toLowerCase().replace(/\.$/, "");

function isSameSite(check: string, relative: string): boolean {
	check = normaliseHostname(check);
	relative = normaliseHostname(relative);

	if (check === relative) return true;

	const checkParts = check.split(".");
	const relativeParts = relative.split(".");

	if (checkParts.length <= relativeParts.length) return false;

	// Check if the last parts of A match all of B
	const slicedCheck = checkParts.slice(-relativeParts.length);
	return slicedCheck.every((part, index) => part === relativeParts[index]);
}

async function discoverWebmentionEndpoint(
	url: string,
	options: {
		crossOriginPolicy: CrossOriginPolicy;
		allowedOrigins: URL[];
	},
): Promise<WebmentionEndpoint> {
	const webmentionEndpoint = (await tryHeadRequest(url)) ?? (await tryGetRequest(url));
	if (webmentionEndpoint instanceof WebmentionEndpoint.Error) return webmentionEndpoint;

	/**
	 * @abstract The endpoint MAY be a relative URL, in which case the sender MUST resolve it relative to the target URL according to [URL].
	 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-2
	 */
	const resolved = new URL(webmentionEndpoint.endpoint, url).href;

	const { crossOriginPolicy, allowedOrigins } = options;

	if (crossOriginPolicy === "cross-origin") return new WebmentionEndpoint.Discovered(resolved);

	const original = new URL(url);
	const found = new URL(resolved);

	if (
		allowedOrigins.some(
			origin => origin.protocol === found.protocol && origin.host === found.host && origin.port === found.port,
		)
	)
		return new WebmentionEndpoint.Discovered(resolved);

	if (original.protocol !== found.protocol)
		return crossOriginPolicyViolation(crossOriginPolicy, "protocol", original.protocol, found.protocol);

	if (crossOriginPolicy === "same-origin") {
		if (original.host !== found.host)
			return crossOriginPolicyViolation(crossOriginPolicy, "host", original.host, found.host);

		if (original.port !== found.port)
			// throw new CrossOriginPolicyViolation("same-origin", "port", original.port, found.port);
			return crossOriginPolicyViolation(crossOriginPolicy, "port", original.port, found.port);

		return new WebmentionEndpoint.Discovered(resolved);
	}

	if (crossOriginPolicy === "same-site") {
		if (!isSameSite(original.host, found.host))
			return crossOriginPolicyViolation(crossOriginPolicy, "host", original.host, found.host);

		return new WebmentionEndpoint.Discovered(resolved);
	}

	return new WebmentionEndpoint.Discovered(resolved);
}

export namespace WebmentionResponse {
	export class Accepted {
		constructor(public location?: string) {}
	}

	export class Error {
		constructor(public message: string, public code?: number) {}
	}
}

export type WebmentionResponse = WebmentionResponse.Accepted | WebmentionResponse.Error;

async function notifyReceiver(
	webmentionEndpoint: string,
	source: string,
	target: string,
	options: {
		userAgent: string;
	},
): Promise<WebmentionResponse> {
	if (options.userAgent && !/webmention/i.test(options.userAgent)) {
		console.warn(
			"Custom User Agent specified, but does not contain 'Webmention'. It is recommended to include 'Webmention' in the User Agent." +
				"\nSee https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-7",
		);
	}

	/**
	 * @abstract "The sender MUST post x-www-form-urlencoded [HTML5] source and target parameters to the Webmention endpoint, where source is the URL of the sender's page containing a link, and target is the URL of the page being linked to."
	 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-notifies-receiver-p-1
	 */
	const response = await fetch(webmentionEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": options.userAgent,
		},
		body: new URLSearchParams({ source, target }).toString(),
	});

	if (response.status === 201) {
		/**
		 * @abstract "If the response code is 201, the Location header will include a URL that can be used to monitor the status of the request."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-notifies-receiver-p-3
		 */
		const header = response.headers.get("location");
		if (header) return new WebmentionResponse.Accepted(header);
	} else if (response.ok) {
		/**
		 * @abstract "cross-origin 2xx response code MUST be considered a success."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-notifies-receiver-p-4
		 */
		return new WebmentionResponse.Accepted();
	}

	try {
		const message = await response.text();
		return new WebmentionResponse.Error(message, response.status);
	} catch (error) {
		return new WebmentionResponse.Error(response.statusText, response.status);
	}
}

export function Sender(options?: {
	/**
	 * An extension to WebMention protocol, allowing the sender to specify the cross-origin policy.
	 *
	 * * `"same-origin"`: do not send the WebMention if the resolved WebMention URL is not on the same origin (same protocol, domain, and port) as the target URL.
	 * * `"same-site"`: do not send the WebMention if the resolved WebMention URL is not on the same site (same protocol, but different subdomain or port are allowed) as the target URL.
	 * * `"cross-origin"`: send the WebMention regardless of the origin of the resolved WebMention URL.
	 *
	 * @default "cross-origin"
	 */
	crossOriginPolicy?: CrossOriginPolicy;
	/**
	 * An extension to WebMention protocol, allowing the sender to specify a list of allowed origins.
	 * If the `crossOriginPolicy` restricts the origin, the resolved WebMention URL must be in the list of allowed origins.
	 * Otherwise the WebMention will not be sent.
	 *
	 * @default ["https://webmention.io"]
	 */
	allowedOrigins?: string[];
	/**
	 * Specify a custom User Agent for the HTTP requests.
	 *
	 * @default "HyperWeb WebmentionSender/${version}"
	 */
	userAgent?: string;
}) {
	const userAgent = options?.userAgent ?? USER_AGENT;
	const crossOriginPolicy = options?.crossOriginPolicy ?? CROSS_ORIGIN_POLICY;
	const allowedOrigins = (options?.allowedOrigins ?? ["https://webmention.io"]).map(
		origin => new URL(/(https?:\/\/[^/]+)/.test(origin) ? origin : `https://${origin}`),
	);

	/**
	 * @see https://www.w3.org/TR/2017/REC-webmention-20170112
	 */
	return async function sendWebmention(source: string, target: string): Promise<WebmentionResponse> {
		const webmentionEndpoint = await discoverWebmentionEndpoint(target, { crossOriginPolicy, allowedOrigins });

		if (webmentionEndpoint instanceof WebmentionEndpoint.Error) {
			const message = webmentionEndpoint.message ?? "Unknown error";
			return new WebmentionResponse.Error(message, webmentionEndpoint.code);
		}

		return notifyReceiver(webmentionEndpoint.endpoint, source, target, { userAgent });
	};
}
