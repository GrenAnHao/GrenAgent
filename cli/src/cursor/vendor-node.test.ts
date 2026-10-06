import assert from "node:assert/strict";
import test from "node:test";
import { collapseVariants } from "./vendor/catalog/compat/collapse.ts";
import { factoryDroidModelCacheProviderId } from "./vendor/catalog/wire/factory-droid.ts";
import { getDaemonRuntimeDir, hashPath } from "./vendor/pi-utils/dirs.ts";
import { declareWorkerHostEntry } from "./vendor/pi-utils/worker-host.ts";
import { pollCursorAuth } from "./vendor/registry/oauth/cursor.ts";
import { truncateResponseItemId } from "./vendor/utils.ts";

function cursorTier(id: string) {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

test("同一路径的哈希稳定，且不依赖 Bun.hash", () => {
	const path = "D:\\cursor\\same";
	const hashed = hashPath(path);
	assert.equal(hashed, hashPath(path));
	assert.match(hashed, /^[0-9a-f]{7}$/);

	const daemon = getDaemonRuntimeDir(path);
	assert.equal(daemon, getDaemonRuntimeDir(path));

	const longId = "x".repeat(80);
	assert.equal(truncateResponseItemId(longId, "fc"), truncateResponseItemId(longId, "fc"));
	assert.equal(
		factoryDroidModelCacheProviderId({ apiKey: "test-key" }),
		factoryDroidModelCacheProviderId({ apiKey: "test-key" }),
	);
});

test("折叠 Cursor 档位时深度比较不相等不会读 Bun.deepEquals", () => {
	const collapsed = collapseVariants([cursorTier("acme-low"), cursorTier("acme-high")]);
	assert.ok(Array.isArray(collapsed));
	assert.ok(collapsed.length >= 1);
});

test("Cursor 登录轮询的等待不读 Bun.sleep", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ accessToken: "tok", refreshToken: "ref" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	try {
		const credentials = await pollCursorAuth("uuid", "verifier");
		assert.equal(credentials.accessToken, "tok");
		assert.equal(credentials.refreshToken, "ref");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("声明 worker 入口不读 Bun.main", () => {
	declareWorkerHostEntry();
	assert.equal(typeof declareWorkerHostEntry, "function");
});
