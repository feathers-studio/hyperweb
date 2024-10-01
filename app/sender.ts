import { version } from "../package.json";

import { Readable } from "node:stream";
import { WritableStream } from "htmlparser2/lib/WritableStream";

type CrossSitePolicy = "same-origin" | "same-site" | "cross-origin";

const CROSS_ORIGIN_POLICY: CrossSitePolicy = "cross-origin";

/**
 * @abstract "Senders MAY customize the HTTP User Agent [RFC7231] used when fetching the target URL..."
 * @abstract "In this case, it is recommended to include the string "Webmention" in the User Agent."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-7
 */
const CUSTOM_USER_AGENT = "HyperWeb WebmentionSender/" + version;

const f = (url: string, method: "HEAD" | "GET") =>
	fetch(url, {
		method,
		redirect: "follow",
		headers: { "User-Agent": CUSTOM_USER_AGENT },
	});

const relRegex = /rel="([^"]+)"/;

/**
 * @abstract "check for an HTTP Link header [RFC5988] with a rel value of webmention"
 * @abstract "the first HTTP Link header takes precedence"
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-1
 */
function tryParseWebmentionLinkHeader(response: Response) {
	const header = response.headers.get("link");
	if (!header) return;
	const links = header.split(",");

	for (const link of links) {
		const [urlpart, relpart] = link.split(";");
		if (urlpart[0] !== "<" || urlpart.slice(-1) !== ">") continue;
		if (!relRegex.test(relpart)) continue;
		const url = urlpart.slice(1, -1);
		const rel = relpart.match(relRegex)?.[1];
		if (rel !== "webmention") continue;
		return url;
	}
}

/**
 * @abstract "If the content type of the document is HTML, then the sender MUST look for an HTML `<link>` and `<a>` element with a rel value of webmention."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-1
 */
async function tryParseHTML(response: Response) {
	if (!response.body) return;

	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("text/html")) return;

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

	return webmentionEndpoint;
}

/**
 *
 * @abstract "Senders MAY initially make an HTTP HEAD request [RFC7231] to check for the Link header before making a GET request."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-4
 */
async function tryHeadRequest(url: string) {
	const response = await fetch(url, { method: "HEAD", redirect: "follow" });
	if (!response.ok) return;
	return tryParseWebmentionLinkHeader(response);
}

/**
 * @abstract "The sender MUST fetch the target URL (and follow redirects [FETCH])"
 * @abstract "If the content type of the document is HTML, then the sender MUST look for an HTML <link> and <a> element with a rel value of webmention."
 * @abstract "If more than one of these is present, the first HTTP Link header takes precedence, followed by the first `<link>` or `<a>` element in document order. Senders MUST support all three options and fall back in this order."
 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-1
 */
async function tryGetRequest(url: string) {
	const response = await fetch(url, { method: "GET", redirect: "follow" });
	if (!response.ok) return;

	const webmentionEndpoint = tryParseWebmentionLinkHeader(response);
	if (webmentionEndpoint) return webmentionEndpoint;

	return tryParseHTML(response);
}

export class CrossOriginPolicyViolation extends Error {
	constructor(policy: CrossSitePolicy, violation: "protocol" | "host", expected: string, found: string) {
		super(`${policy} policy violation (${violation}): expected ${expected}, found ${found}`);
		this.name = "CrossOriginPolicyViolation";
	}
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

async function discoverWebmentionEndpoint(url: string, crossSitePolicy: CrossSitePolicy) {
	const webmentionEndpoint = (await tryHeadRequest(url)) ?? (await tryGetRequest(url));
	if (!webmentionEndpoint) return;

	/**
	 * @abstract The endpoint MAY be a relative URL, in which case the sender MUST resolve it relative to the target URL according to [URL].
	 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-discovers-receiver-webmention-endpoint-p-2
	 */
	const resolved = new URL(webmentionEndpoint, url).href;

	if (crossSitePolicy === "cross-origin") return resolved;

	const original = new URL(url);
	const found = new URL(resolved);

	if (original.protocol !== found.protocol)
		throw new CrossOriginPolicyViolation(crossSitePolicy, "protocol", original.protocol, found.protocol);

	if (crossSitePolicy === "same-origin") {
		if (original.host !== found.host)
			throw new CrossOriginPolicyViolation("same-origin", "host", original.host, found.host);

		return resolved;
	}

	if (crossSitePolicy === "same-site") {
		if (!isSameSite(original.host, found.host))
			throw new CrossOriginPolicyViolation("same-site", "host", original.host, found.host);

		return resolved;
	}

	return resolved;
}

export namespace WebmentionResponse {
	export interface Accepted {
		status: "accepted";
		location?: string;
	}

	export interface Error {
		status: "error";
		code?: number;
		message?: string;
	}
}

export type WebmentionResponse = WebmentionResponse.Accepted | WebmentionResponse.Error;

async function notifyReceiver(webmentionEndpoint: string, source: string, target: string): Promise<WebmentionResponse> {
	/**
	 * @abstract "The sender MUST post x-www-form-urlencoded [HTML5] source and target parameters to the Webmention endpoint, where source is the URL of the sender's page containing a link, and target is the URL of the page being linked to."
	 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-notifies-receiver-p-1
	 */
	const response = await fetch(webmentionEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": CUSTOM_USER_AGENT,
		},
		body: new URLSearchParams({ source, target }).toString(),
	});

	if (response.status === 201) {
		/**
		 * @abstract "If the response code is 201, the Location header will include a URL that can be used to monitor the status of the request."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-notifies-receiver-p-3
		 */
		const header = response.headers.get("location");
		if (header) return { status: "accepted", location: header };
	} else if (response.ok) {
		/**
		 * @abstract "Any 2xx response code MUST be considered a success."
		 * @see https://www.w3.org/TR/2017/REC-webmention-20170112/#sender-notifies-receiver-p-4
		 */
		return { status: "accepted" };
	}

	try {
		const message = await response.text();
		return { status: "error", code: response.status, message };
	} catch (error) {
		return { status: "error", code: response.status, message: response.statusText };
	}
}

export async function sendWebmention(
	source: string,
	target: string,
	options?: {
		crossOriginPolicy?: CrossSitePolicy;
	},
): Promise<WebmentionResponse> {
	const crossOriginPolicy = options?.crossOriginPolicy ?? CROSS_ORIGIN_POLICY;
	const webmentionEndpoint = await discoverWebmentionEndpoint(target, crossOriginPolicy);
	if (!webmentionEndpoint) return { status: "error", message: "No webmention endpoint found" };
	return notifyReceiver(webmentionEndpoint, source, target);
}
