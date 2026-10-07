import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLoginUrl } from "./open-url.ts";
import { isCursorTokenExpiringSoon, loginCursor, refreshCursorToken } from "./vendor/registry/oauth/cursor.ts";

export { openLoginUrl };

export interface CursorCredentials {
	access: string;
	refresh: string;
	expires: number;
}

export interface ResolveCursorAccessOptions {
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	login?: () => Promise<CursorCredentials>;
	platform?: string;
	spawn?: (command: string[]) => void;
}

export async function resolveCursorAccessToken(
	agentDir: string,
	options: ResolveCursorAccessOptions = {},
): Promise<string> {
	const path = join(agentDir, "cursor-credentials.json");
	const stored = await readCursorCredentials(path);
	if (stored && !isCursorTokenExpiringSoon(stored.access)) return stored.access;

	if (stored?.refresh) {
		try {
			const refreshed = await usingFetch(options.fetch, () => refreshCursorToken(stored.refresh));
			await writeCursorCredentials(path, refreshed);
			return refreshed.access;
		} catch {
			// Refresh failed. Log in instead of returning the stored access token.
		}
	}

	const loggedIn = options.login
		? await options.login()
		: await usingFetch(options.fetch, () =>
				loginCursor((url) => {
					openLoginUrl(url, { platform: options.platform, spawn: options.spawn });
				}),
			);
	await writeCursorCredentials(path, loggedIn);
	return loggedIn.access;
}

interface InstalledFetch {
	impl: typeof globalThis.fetch;
}

const fetchStack: InstalledFetch[] = [];
let fetchBaseline: typeof globalThis.fetch | undefined;

async function usingFetch<T>(
	fetchImpl: ResolveCursorAccessOptions["fetch"],
	run: () => Promise<T>,
): Promise<T> {
	if (!fetchImpl) return run();
	const frame: InstalledFetch = { impl: fetchImpl as typeof globalThis.fetch };
	if (fetchStack.length === 0) fetchBaseline = globalThis.fetch;
	fetchStack.push(frame);
	globalThis.fetch = frame.impl;
	try {
		return await run();
	} finally {
		const index = fetchStack.indexOf(frame);
		if (index !== -1) fetchStack.splice(index, 1);
		const top = fetchStack[fetchStack.length - 1];
		if (top) {
			globalThis.fetch = top.impl;
		} else if (fetchBaseline !== undefined) {
			globalThis.fetch = fetchBaseline;
			fetchBaseline = undefined;
		}
	}
}

async function readCursorCredentials(path: string): Promise<CursorCredentials | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isCursorCredentials(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeCursorCredentials(path: string, credentials: CursorCredentials): Promise<void> {
	await writeFile(
		path,
		JSON.stringify({
			access: credentials.access,
			refresh: credentials.refresh,
			expires: credentials.expires,
		}),
	);
}

function isCursorCredentials(value: unknown): value is CursorCredentials {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.access === "string" &&
		typeof record.refresh === "string" &&
		typeof record.expires === "number"
	);
}
