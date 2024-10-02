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
