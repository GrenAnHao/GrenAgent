import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLoginUrl, resolveCursorAccessToken } from "./oauth.ts";

const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");

function tokenExpiringAt(exp: number, signature: string): string {
	return `${header}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.${signature}`;
}

test("有效令牌直接使用，快过期先刷新，刷新失败则登录且不返回旧令牌", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-auth-"));
	const credentials = join(dir, "cursor-credentials.json");
	try {
		const later = Math.floor(Date.now() / 1000) + 3600;
		const fresh = tokenExpiringAt(later, "x");
		await writeFile(credentials, JSON.stringify({ access: fresh, refresh: "r", expires: later * 1000 }));
		let calls = 0;
		const used = await resolveCursorAccessToken(dir, {
			fetch: async () => {
				calls += 1;
				throw new Error("no network");
			},
		});
		assert.equal(used, fresh);
		assert.equal(calls, 0);

		const soon = Math.floor(Date.now() / 1000) + 60;
		const expiring = tokenExpiringAt(soon, "x");
		await writeFile(credentials, JSON.stringify({ access: expiring, refresh: "r", expires: soon * 1000 }));
		const urls: string[] = [];
		const refreshed = await resolveCursorAccessToken(dir, {
			fetch: async (input) => {
				urls.push(String(input));
				const access = tokenExpiringAt(later, "y");
				return new Response(JSON.stringify({ accessToken: access, refreshToken: "r2" }), { status: 200 });
			},
		});
		assert.deepEqual(urls, ["https://api2.cursor.sh/auth/exchange_user_api_key"]);
		assert.notEqual(refreshed, expiring);
		const saved = JSON.parse(await readFile(credentials, "utf8")) as {
			access: string;
			refresh: string;
			expires: number;
		};
		assert.equal(saved.access, refreshed);
		assert.equal(saved.refresh, "r2");
		assert.notEqual(saved.expires, soon * 1000);

		await writeFile(
			credentials,
			JSON.stringify({ access: expiring, refresh: "refresh-secret", expires: soon * 1000 }),
		);
		const events: string[] = [];
		await assert.rejects(
			() =>
				resolveCursorAccessToken(dir, {
					fetch: async (input) => {
						events.push(String(input));
						return new Response("no", { status: 401 });
					},
					login: async () => {
						events.push("login");
						throw new Error("login-required");
					},
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /login-required/);
				assert.equal(error.message.includes(expiring), false);
				assert.equal(error.message.includes("refresh-secret"), false);
				return true;
			},
		);
		assert.deepEqual(events, ["https://api2.cursor.sh/auth/exchange_user_api_key", "login"]);
		const unchanged = JSON.parse(await readFile(credentials, "utf8")) as { access: string };
		assert.equal(unchanged.access, expiring);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("win32 把登录 URL 原样交给 rundll32", async () => {
	const url = "https://cursor.com/loginDeepControl?challenge=abc&uuid=0932cd43-ee6b-4905-a016-268f839c0b23";
	const commands: string[][] = [];
	await openLoginUrl(url, {
		platform: "win32",
		spawn: (cmd) => {
			commands.push(cmd);
		},
	});
	assert.deepEqual(commands, [["rundll32", "url.dll,FileProtocolHandler", url]]);
	assert.match(commands[0]?.[2] ?? "", /challenge=abc/);
	assert.match(commands[0]?.[2] ?? "", /uuid=0932cd43-ee6b-4905-a016-268f839c0b23/);
});

test("登录 URL 由 Cursor PKCE 生成，轮询打到 auth/poll", { timeout: 10_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-auth-login-"));
	const commands: string[][] = [];
	const fetched: string[] = [];
	try {
		const token = await resolveCursorAccessToken(dir, {
			platform: "win32",
			spawn: (cmd) => {
				commands.push(cmd);
			},
			fetch: async (input) => {
				const url = String(input);
				fetched.push(url);
				if (url.startsWith("https://api2.cursor.sh/auth/poll")) {
					return new Response(JSON.stringify({ accessToken: "polled-access", refreshToken: "polled-refresh" }), {
						status: 200,
					});
				}
				throw new Error(`unexpected ${url}`);
			},
		});
		assert.equal(token, "polled-access");
		const opened = commands[0]?.[2] ?? "";
		assert.equal(commands[0]?.slice(0, 2).join(" "), "rundll32 url.dll,FileProtocolHandler");
		assert.equal(commands[0]?.length, 3);
		assert.ok(opened.startsWith("https://cursor.com/loginDeepControl?"));
		const params = new URL(opened).searchParams;
		assert.equal(typeof params.get("challenge"), "string");
		assert.ok(params.get("challenge"));
		assert.equal(typeof params.get("uuid"), "string");
		assert.ok(params.get("uuid"));
		assert.ok(fetched.some((url) => url.startsWith("https://api2.cursor.sh/auth/poll")));
		const saved = JSON.parse(await readFile(join(dir, "cursor-credentials.json"), "utf8")) as {
			access: string;
			refresh: string;
		};
		assert.equal(saved.access, "polled-access");
		assert.equal(saved.refresh, "polled-refresh");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
