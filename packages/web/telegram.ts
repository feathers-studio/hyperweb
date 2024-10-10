import { SQLiteError } from "bun:sqlite";

import { Telegraf } from "telegraf";
import type { Sender } from "@hyperactive/mentions/sender";

import type { Storage } from "./store";

export function Telegram({
	store,
	token,
	owner,
	blog_root,
	sender,
}: {
	store: Storage;
	token: string;
	owner: number;
	blog_root: string;
	sender: Sender;
}) {
	const bot = new Telegraf(token);

	bot.command("publish", async ctx => {
		if (ctx.from.id !== owner) return;

		const { reply_to_message } = ctx.message;
		if (!reply_to_message) return;
		if ("text" in reply_to_message) {
			const { text, entities = [] } = reply_to_message;
			const firstLineEnd = text.indexOf("\n");
			const title = text.slice(0, firstLineEnd);
			const content = text.slice(firstLineEnd + 1).trim();
			const slug = ctx.payload;
			const author = ctx.from.username ?? ctx.from.first_name;

			try {
				await store.posts.create({ slug, title, author, content, entities, draft: false });
			} catch (error) {
				if (error instanceof SQLiteError) {
					if (error.code === "SQLITE_CONSTRAINT_UNIQUE")
						return ctx.reply(`Post already exists: ${blog_root}/${slug}. Use /update {slug} to edit.`);
					else return ctx.reply(`Failed to create post: ${error.message}, ${error.code}`);
				}

				return ctx.reply(`Failed to create post: ${error}`);
			}

			await ctx.reply(`Post created: ${blog_root}/${slug}`);
		}
	});

	bot.command("update", async ctx => {
		console.log(ctx.message);
		if (ctx.from.id !== owner) return;

		const { reply_to_message } = ctx.message;
		if (!reply_to_message) return;
		if ("text" in reply_to_message) {
			const { text, entities = [] } = reply_to_message;
			const firstLineEnd = text.indexOf("\n");
			const title = text.slice(0, firstLineEnd);
			const content = text.slice(firstLineEnd + 1).trim();
			const slug = ctx.payload;
			const author = ctx.from.username ?? ctx.from.first_name;

			try {
				await store.posts.update({ slug, title, author, content, entities, draft: false });
			} catch (error) {
				if (error instanceof SQLiteError)
					return ctx.reply(`Failed to update post: ${error.message}, ${error.code}`);

				return ctx.reply(`Failed to update post: ${error}`);
			}

			await ctx.reply(`Post updated: ${blog_root}/${slug}`);
		}
	});

	return bot;
}
