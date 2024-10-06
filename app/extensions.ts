// GUIDE to this file
// Raw = the data type that comes from the request
// Parsed = the webmention massaged into a format we can store efficiently
// Normalised = the webmention in a format that's easy to work with after retrieval from the database

import { z } from "zod";
import { Err } from "./util";

export interface BaseWebmention {
	source: string;
	target: string;
}

export type RawWebmentionWithPossiblePayload = BaseWebmention & Record<string, string>;

/**
 * WARNING! Enum order cannot be changed
 * To add a new extension, add it to the end of the enum
 * To remove an extension, underscore and leave it in place. We cannot remove it
 * because it would change the index of the other extensions and break the database
 */
export const enum ExtensionKind {
	Unknown,
	Basic,
	Like,
	Comment,
}

const nil = z.null().or(z.undefined());
const empty = nil.or(z.object({}).strict());

export const like = {
	kind: ExtensionKind.Like,
	definition: "https://webmention.feathers.studio/like/1.0/",
	payload: empty,
};

export const comment = {
	kind: ExtensionKind.Comment,
	definition: "https://webmention.feathers.studio/comment/1.0/",
	payload: empty,
};

export const extensions = {
	[like.definition]: like,
	[comment.definition]: comment,
};

export const extensionFromKind = Object.fromEntries(
	Object.values(extensions).map(extension => [extension.kind, extension]),
) as Record<ExtensionKind, (typeof extensions)[keyof typeof extensions]>;

export interface ParsedWebmentionBase extends BaseWebmention {
	kind: ExtensionKind.Basic;
	payload: null;
}

export interface ParsedWebmentionExtended extends BaseWebmention {
	kind: Exclude<ExtensionKind, ExtensionKind.Unknown | ExtensionKind.Basic>;
	payload: z.infer<(typeof extensions)[keyof typeof extensions]["payload"]>;
}

export interface ParsedWebmentionUnknownExtension extends BaseWebmention {
	kind: ExtensionKind.Unknown;
	payload: {
		definition: string;
		payload: object | null | undefined;
	};
}

export type ParsedWebmention = ParsedWebmentionBase | ParsedWebmentionExtended | ParsedWebmentionUnknownExtension;

export function parseExtension(mention: RawWebmentionWithPossiblePayload): ParsedWebmention | Err {
	const definition = mention.definition;

	let parsed;
	try {
		parsed = JSON.parse(mention.payload ?? null);
	} catch (error) {
		return new Err("Payload is not valid JSON", 400);
	}

	if (definition in extensions) {
		const extension = extensions[definition];
		const payload = extension.payload.safeParse(parsed);
		if (payload.error) return new Err("Payload is not valid", 400);

		return {
			source: mention.source,
			target: mention.target,
			kind: extension.kind as ExtensionKind.Like | ExtensionKind.Comment,
			payload: payload.data,
		};
	} else if (definition) {
		return {
			source: mention.source,
			target: mention.target,
			kind: ExtensionKind.Unknown,
			payload: {
				// For unknown extensions, store the definition with the payload
				definition,
				payload: parsed,
			},
		};
	} else {
		if (mention.payload) return new Err("Payload is not allowed without a definition field", 400);
		return {
			source: mention.source,
			target: mention.target,
			kind: ExtensionKind.Basic,
			payload: null,
		};
	}
}

export interface NormalisedWebmention extends BaseWebmention {
	definition: string;
	payload: object | null | undefined;
}

export function reparseExtension(webmention: ParsedWebmention): NormalisedWebmention | Err {
	const definition = extensionFromKind[webmention.kind];

	if (!definition) return new Err("Invalid webmention kind", 400);

	if (webmention.kind === ExtensionKind.Unknown) {
		return {
			source: webmention.source,
			target: webmention.target,
			definition: webmention.payload.definition,
			payload: webmention.payload.payload,
		};
	} else
		return {
			source: webmention.source,
			target: webmention.target,
			definition: definition.definition,
			payload: webmention.payload,
		};
}
