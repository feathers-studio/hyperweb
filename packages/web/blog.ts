import { renderHTML, elements } from "@hyperactive/hyper";
import type { Storage } from "./store";
import { parseAsValidSubpath } from "./util";

const { html, head, title, meta, body, h1, p, a, time, article, header, footer, main, nav, section, ul, li, script } =
	elements;

export function Blog({ store, blog_root }: { store: Storage; blog_root: string }) {
	function list() {
		const posts = store.posts.list();
		return renderHTML(
			html(
				head(title("Blog")),
				body(main(ul(...posts.map(post => li(a({ href: `${blog_root}/${post.slug}` }, post.title)))))),
			),
		);
	}

	function post(slug: string) {
		const post = store.posts.get(slug);
		if (!post) return null;

		const created = new Date(post.created_at).toString();
		const updated = new Date(post.updated_at).toString();

		return renderHTML(
			html(
				head(
					title(post.title),
					meta({ charset: "utf-8" }),
					meta({ name: "viewport", content: "width=device-width, initial-scale=1" }),
				),
				body(
					header(nav(a({ href: "/" }, "Home"))),
					main(
						article(
							header(h1(post.title)),
							section(p(post.content)),
							footer(
								p("Created: ", time({ datetime: created }, created)),
								p("Updated: ", time({ datetime: updated }, updated)),
								p("—", post.author),
							),
						),
					),
				),
				script({ src: "/js/main.js" }),
			),
		);
	}

	const root_path = new URL(blog_root).pathname;

	return function blogHandler(request: Request) {
		const path = new URL(request.url).pathname;
		const subpath = parseAsValidSubpath(root_path, path);

		if (!subpath) return new Response("Not found", { status: 404 });

		if (path === "/") {
			const rendered = list();
			return new Response(rendered, { headers: { "Content-Type": "text/html" } });
		}

		const rendered = post(subpath);
		if (!rendered) return new Response("Not found", { status: 404 });
		return new Response(rendered, { headers: { "Content-Type": "text/html" } });
	};
}
