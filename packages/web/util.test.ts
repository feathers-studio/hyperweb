import { expect, test } from "bun:test";

import { parseAsValidSubpath, matchDomain } from "./util";

{
	const testCases = [
		{ path: "index.html", expected: "index.html" },
		{ path: "../index.html", expected: null },
		{ path: "public/index.html", expected: "public/index.html" },
		{ path: "public/../../index.html", expected: null },
	];

	for (const testCase of testCases) {
		const name = testCase.expected ? `Expect pass : ${testCase.path}` : `Expect fail : ${testCase.path}`;

		test(name, () => expect(parseAsValidSubpath("public", testCase.path)).toBe(testCase.expected));
	}
}

{
	const testCases = [
		{ pattern: "example.com", domain: "example.com", expected: true },
		{ pattern: "*.example.com", domain: "sub.example.com", expected: true },
		{ pattern: "*.example.com", domain: "sub.sub.example.com", expected: true },
		{ pattern: "*.example.com", domain: "example.com", expected: false },
		{ pattern: "foo.*.com", domain: "foo.bar.com", expected: true },
		{ pattern: "foo.*.com", domain: "foo.bar.baz.com", expected: true },
		{ pattern: "foo.*.com", domain: "foo.com", expected: false },
		{ pattern: "*foo.com", domain: "barfoo.com", expected: true },
		{ pattern: "*foo.com", domain: "bar.foo.com", expected: true },
		{ pattern: "foo.*bar.com", domain: "foo.baz.bar.com", expected: true },
		{ pattern: "foo.*bar.com", domain: "foo.bazbar.com", expected: true },
		{ pattern: "foo.*bar.com", domain: "foo.baz.baz.bar.com", expected: true },
		{ pattern: "*.example.*", domain: "sub.example.com", expected: true },
		{ pattern: "*.example.*", domain: "sub.example.org", expected: true },
		{ pattern: "*.example.*", domain: "sub.sub.example.co.uk", expected: true },
	];

	for (const testCase of testCases) {
		const name = testCase.expected
			? `Expect pass : ${testCase.pattern} ~ ${testCase.domain}`
			: `Expect fail : ${testCase.pattern} ~ ${testCase.domain}`;

		test(name, () => expect(matchDomain(testCase.pattern, testCase.domain)).toBe(testCase.expected));
	}
}
