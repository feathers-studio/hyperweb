export const isObject = (val: unknown): val is Record<string, unknown> => typeof val === "object" && val !== null;

export class Err extends Response {
	constructor(text?: string, status: number = 500) {
		super(text, { status });
	}
}

export async function trya<F extends (...args: any[]) => any, E = unknown>(
	f: F,
	errmap: (err: unknown) => E = err => err as E,
): Promise<ReturnType<F> | E> {
	try {
		return await f();
	} catch (e) {
		return errmap(e);
	}
}

export function trys<F extends (...args: any[]) => any, E = unknown>(
	f: F,
	errmap: (err: unknown) => E = err => err as E,
): ReturnType<F> | E {
	try {
		return f();
	} catch (e) {
		return errmap(e);
	}
}

export function matchDomain(pattern: string, domain: string): boolean {
	if (pattern === domain) return true;

	// Convert pattern and domain to lowercase for case-insensitive matching
	pattern = pattern.toLowerCase();
	domain = domain.toLowerCase();

	// Escape special regex characters except for asterisk
	const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

	// Replace asterisks with regex that matches any number of subdomains
	const regexPattern = "^" + escapedPattern.replace(/\*/g, ".*?") + "$";

	// console.log(regexPattern);

	// Create RegExp object
	const regex = new RegExp(regexPattern);

	// Test the domain against the pattern
	return regex.test(domain);
}

export type InnerObjectToString<T> = T extends object
	? {
			[K in keyof T]: T[K] extends object | Array<any> | undefined | null
				? Exclude<T[K], object | Array<any>> | string
				: T[K];
	  }
	: never;

export const innerObjectToString = <T>(obj: T): InnerObjectToString<T> => {
	const modified: any = { ...obj };

	// Arrays are objects too
	for (const key in modified) if (isObject(modified[key])) modified[key] = JSON.stringify(modified[key]);

	return modified;
};
