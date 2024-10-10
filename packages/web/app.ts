import { serve } from "bun";

import { Sender } from "@hyperactive/mentions/sender";
import { Receiver, type Storage as ReceiverStorage } from "@hyperactive/mentions/receiver";

import { Storage } from "./store.ts";
import { Blog } from "./blog.ts";
import { Telegram } from "./telegram.ts";
import { readEnv } from "./util.ts";
import { Public } from "./public.ts";

const token = readEnv("TOKEN");
const owner = parseInt(readEnv("OWNER"));
const blog_root = readEnv("BLOG_ROOT");
const store_path = readEnv("STORE_PATH", "store.sqlite");
const static_path = readEnv("STATIC_PATH", "public");
const port = parseInt(readEnv("PORT", "8080"));

const store = Storage(store_path, { disableWAL: true });

const receiverStore: ReceiverStorage = {
	insert: async webmention => store.webmentions.create(webmention),
	delete: async webmention => store.webmentions.delete(webmention),
};

const blog = Blog({ store, blog_root });
const receiver = Receiver(receiverStore);
const sender = Sender();
const bot = Telegram({ store, token, owner, blog_root, sender });
const public_handler = Public(static_path);

console.log("Starting server");

const app = serve({
	port,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/webmention") return receiver(req);

		const res = await public_handler(req);
		if (res.status !== 404) return res;

		return blog(req);
	},
});

bot.launch(() => console.log("Bot started"));

process.on("SIGINT", () => {
	console.log("Stopping server");
	app.stop();
	console.log("Closing database");
	store.close();
	console.log("Stopping bot");
	bot.stop();
	console.log("Done!");
});
