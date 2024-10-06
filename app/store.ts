import { Database } from "bun:sqlite";
import type { BaseWebmention, GenericWebmention } from "./extensions.ts";
import { isObject } from "./util.ts";

type InnerObjectToString<T> = T extends object
	? { [K in keyof T]: T[K] extends object | undefined | null ? Exclude<T[K], object> | string : T[K] }
	: never;

const innerObjectToString = <T>(obj: T): InnerObjectToString<T> => {
	const modified: any = { ...obj };
	for (const key in modified) {
		if (isObject(modified[key])) {
			modified[key] = JSON.stringify(modified[key]);
		}
	}
	return modified;
};

export interface Storage {
	db: Database;
	getWebmentions: (mention: Partial<BaseWebmention>) => GenericWebmention[];
	createWebmention: (webmention: GenericWebmention) => void;
	deleteWebmention: (webmention: BaseWebmention) => void;
	close: () => void;
}

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

	db.query(`
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
	`);

	const queries = {
		createWebmention: db.query<void, InnerObjectToString<GenericWebmention>>(`
			INSERT INTO webmentions (source, target, definition, payload)
			VALUES (:source, :target, :definition, :payload)
			ON CONFLICT(source, target)
			DO UPDATE SET updated_at = CURRENT_TIMESTAMP
		`),
		deleteWebmention: db.query<void, { source: string; target: string }>(`
			DELETE FROM webmentions WHERE source = :source AND target = :target
		`),
	};

	return {
		db,
		getWebmentions: mention => {
			let query = "SELECT * FROM webmentions WHERE";
			const parts = [];
			if (mention.source) parts.push("source = :source");
			if (mention.target) parts.push("target = :target");
			if (parts.length === 0) return [];

			query += " " + parts.join(" AND ");
			query += " ORDER BY created_at DESC";

			return db.query<BaseWebmention, Partial<BaseWebmention>>(query).all(mention);
		},
		createWebmention: (webmention: GenericWebmention) =>
			queries.createWebmention.run(innerObjectToString(webmention)),
		deleteWebmention: (webmention: BaseWebmention) => queries.deleteWebmention.run(webmention),
		close: () => db.close(),
	};
};
