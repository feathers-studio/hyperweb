import { resolve, extname } from "node:path";
import { parseAsValidSubpath } from "./util";

const CONTENT_TYPES = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
};

export function Public(static_path: string, content_types: Record<string, string> = CONTENT_TYPES) {
	return async function publicHandler(request: Request) {
		const url = new URL(request.url);
		const subpath = parseAsValidSubpath(static_path, url.pathname.slice(1));
		if (subpath) {
			const file = Bun.file(resolve(static_path, subpath));
			if (await file.exists()) {
				const ext = extname(subpath);
				const contentType = content_types[ext];
				if (!contentType) return new Response("Unsupported content type", { status: 400 });
				return new Response(file, { headers: { "Content-Type": contentType } });
			}
		}

		return new Response("Not found", { status: 404 });
	};
}

export type Public = ReturnType<typeof Public>;
