import { z } from "zod";
import { Err } from "../../../app/util";

export type BaseWebmention = {
	source: string;
	target: string;
};

export type RawWebmentionWithPossiblePayload = BaseWebmention & Record<string, string>;

const nil = z.null().or(z.undefined());
const empty = nil.or(z.object({}).strict());

// TODO: mentions should have context, whether the mention happened in a post or reply, etc.

export const mention = {
	definition: "https://webmention.feathers.studio/mention/1.0/",
	payload: empty,
};

export type MentionWebmention = BaseWebmention & {
	definition: typeof mention.definition;
	payload: z.infer<typeof mention.payload>;
};

export const like = {
	definition: "https://webmention.feathers.studio/like/1.0/",
	payload: empty,
};

export type LikeWebmention = BaseWebmention & {
	definition: typeof like.definition;
	payload: z.infer<typeof like.payload>;
};

export const comment = {
	definition: "https://webmention.feathers.studio/comment/1.0/",
	payload: empty,
};

export type CommentWebmention = BaseWebmention & {
	definition: typeof comment.definition;
	payload: z.infer<typeof comment.payload>;
};

export const extensions = {
	[mention.definition]: mention,
	[like.definition]: like,
	[comment.definition]: comment,
};

export type GenericWebmention = BaseWebmention & {
	definition?: string;
	payload?: object | null | undefined;
};

export type Webmention = GenericWebmention | LikeWebmention | CommentWebmention | MentionWebmention;

export function parseExtension(
	mention: RawWebmentionWithPossiblePayload,
	{ banUnknownExtensions = false }: { banUnknownExtensions?: boolean },
): Webmention | Err {
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
			definition,
			payload: payload.data,
		};
	} else if (definition) {
		if (banUnknownExtensions)
			return new Err("Webmention extension " + definition + " is not supported by this receiver", 400);

		return {
			source: mention.source,
			target: mention.target,
			definition,
			payload: parsed,
		};
	} else {
		if (mention.payload) return new Err("Payload is not allowed without a definition field", 400);
		return {
			source: mention.source,
			target: mention.target,
		};
	}
}
