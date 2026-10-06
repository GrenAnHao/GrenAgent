import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import type http2 from "node:http2";
import { acquireCursorHttp2Session } from "./h2-pool.ts";

function fakeSession(): http2.ClientHttp2Session {
	const session = new EventEmitter() as http2.ClientHttp2Session;
	let closed = false;
	Object.defineProperty(session, "closed", { get: () => closed });
	Object.defineProperty(session, "destroyed", { get: () => false });
	session.close = () => {
		closed = true;
		return session;
	};
	return session;
}

test("直连会话的 error 不会打崩进程，并且同一源站不再复用它", () => {
	const origin = "https://h2-pool.test";
	const first = fakeSession();
	const acquired = acquireCursorHttp2Session(origin, { proxied: false, connect: () => first });
	assert.equal(acquired, first);

	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => {
		uncaught.push(error);
	};
	process.on("uncaughtException", onUncaught);
	try {
		assert.doesNotThrow(() => {
			first.emit("error", new Error("goaway"));
		});
		assert.deepEqual(uncaught, []);

		const second = fakeSession();
		const again = acquireCursorHttp2Session(origin, { proxied: false, connect: () => second });
		assert.notEqual(again, first);
		assert.equal(again, second);
	} finally {
		process.off("uncaughtException", onUncaught);
	}
});
