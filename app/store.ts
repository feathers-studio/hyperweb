import { Database } from "bun:sqlite";

export type Webmention = {
	source: string;
	target: string;
};

export interface Storage {
	db: Database;
	getWebmentions: (mention: Partial<Webmention>) => Webmention[];
	createWebmention: (webmention: Webmention) => void;
	deleteWebmention: (webmention: Webmention) => void;
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
			type TEXT,
			payload JSONB,

			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

			UNIQUE(source, target)
		)
	`);

	const queries = {
		createWebmention: db.query<void, Webmention>(`
			INSERT INTO webmentions (source, target, created_at, updated_at)
			VALUES (:source, :target, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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

			return db.query<Webmention, Partial<Webmention>>(query).all(mention);
		},
		createWebmention: (webmention: Webmention) => queries.createWebmention.run(webmention),
		deleteWebmention: (webmention: Webmention) => queries.deleteWebmention.run(webmention),
		close: () => db.close(),
	};
};
