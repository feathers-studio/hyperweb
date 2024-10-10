import { Database } from "bun:sqlite";
import type { MessageEntity } from "telegraf/types";

import type { BaseWebmention, GenericWebmention } from "@hyperactive/mentions/extensions";
import { innerObjectToString, type InnerObjectToString } from "./util.ts";

export type Post = {
	author: string;
	title: string;
	content: string;
	entities: MessageEntity[];
	slug: string;
	draft: boolean;
	created_at: string;
	updated_at: string;
};

namespace Storage {
	export interface Webmentions {
		list: (mention: Partial<BaseWebmention>) => GenericWebmention[];
		create: (webmention: GenericWebmention) => void;
		update: (webmention: GenericWebmention) => void;
		delete: (webmention: BaseWebmention) => void;
	}

	export interface Posts {
		get: (slug: string) => Post | null;
		list: () => Post[];
		create: (post: Omit<Post, "id" | "created_at" | "updated_at">) => void;
		update: (post: Omit<Post, "id" | "created_at" | "updated_at">) => void;
		publish: (slug: string) => void;
		delete: (slug: string) => void;
	}
}

export interface Storage {
	db: Database;
	webmentions: Storage.Webmentions;
	posts: Storage.Posts;
	close: () => void;
}

export const Webmentions = (db: Database): Storage.Webmentions => {
	db.query(
		`
		CREATE TABLE IF NOT EXISTS webmentions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,

			source TEXT NOT NULL,
			target TEXT NOT NULL,
			definition TEXT,
			payload JSONB,

			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

			UNIQUE(source, target)
		)
	`,
	).run();

	const queries = {
		create: db.query<void, InnerObjectToString<GenericWebmention>>(`
			INSERT INTO webmentions (source, target, definition, payload)
			VALUES (:source, :target, :definition, :payload)
			ON CONFLICT(source, target)
			DO UPDATE SET updated_at = CURRENT_TIMESTAMP
		`),
		update: db.query<void, InnerObjectToString<GenericWebmention>>(`
			UPDATE webmentions SET definition = :definition, payload = :payload, updated_at = CURRENT_TIMESTAMP
			WHERE source = :source AND target = :target
		`),
		delete: db.query<void, { source: string; target: string }>(`
			DELETE FROM webmentions WHERE source = :source AND target = :target
		`),
	};

	return {
		list: mention => {
			let query = "SELECT id, source, target, definition, json(payload) FROM webmentions WHERE";
			const parts = [];
			if (mention.source) parts.push("source = :source");
			if (mention.target) parts.push("target = :target");
			if (parts.length === 0) return [];

			query += " " + parts.join(" AND ");
			query += " ORDER BY created_at DESC";

			return db.query<BaseWebmention, Partial<BaseWebmention>>(query).all(mention);
		},
		create: webmention => queries.create.run(innerObjectToString(webmention)),
		update: webmention => queries.update.run(innerObjectToString(webmention)),
		delete: webmention => queries.delete.run(webmention),
	};
};

export const Posts = (db: Database): Storage.Posts => {
	db.query(
		`
		CREATE TABLE IF NOT EXISTS posts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,

			author TEXT NOT NULL,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			entities JSONB,
			slug TEXT NOT NULL,

			draft BOOLEAN DEFAULT TRUE,

			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

			UNIQUE(slug)
		)
	`,
	).run();

	const queries = {
		get: db.query<Post, { slug: string }>(`
			SELECT id, author, title, content, json(entities), slug, created_at, updated_at FROM posts WHERE slug = :slug
		`),
		list: db.query<Post, {}>(`
			SELECT id, author, title, content, json(entities), slug, created_at, updated_at FROM posts
		`),
		create: db.query<void, InnerObjectToString<Omit<Post, "id" | "created_at" | "updated_at">>>(`
			INSERT INTO posts (author, title, content, entities, slug)
			VALUES (:author, :title, :content, :entities, :slug)
		`),
		update: db.query<void, InnerObjectToString<Omit<Post, "id" | "created_at" | "updated_at">>>(`
			UPDATE posts SET author = :author, title = :title, content = :content, entities = :entities, draft = :draft, updated_at = CURRENT_TIMESTAMP
			WHERE slug = :slug
		`),
		publish: db.query<void, { slug: string }>(`
			UPDATE posts SET draft = FALSE, updated_at = CURRENT_TIMESTAMP WHERE slug = :slug
		`),
		delete: db.query<void, { slug: string }>(`
			DELETE FROM posts WHERE slug = :slug
		`),
	};
	return {
		get: slug => queries.get.get({ slug }),
		list: () => queries.list.all({}),
		create: post => queries.create.run(innerObjectToString(post)),
		update: post => queries.update.run(innerObjectToString(post)),
		publish: slug => queries.publish.run({ slug }),
		delete: slug => queries.delete.run({ slug }),
	};
};

export const Storage = (
	filename: string,
	options?: {
		/**
		 * Disable WAL mode for SQLite.
		 * @default false
		 */
		disableWAL?: boolean;
	},
): Storage => {
	const db = new Database(filename, { create: true, strict: true });
	if (!options?.disableWAL) db.exec("PRAGMA journal_mode = WAL;");
	return { db, webmentions: Webmentions(db), posts: Posts(db), close: () => db.close() };
};
