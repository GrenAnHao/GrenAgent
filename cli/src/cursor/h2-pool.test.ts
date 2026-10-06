import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import type http2 from "node:http2";
import { acquireCursorHttp2Session, discardCursorHttp2Session } from "./h2-pool.ts";

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

test("同一 authority 直连：discard 前复用同一对象，discard 后新建", () => {
	const origin = "https://h2-pool-reuse.test";
	let connectCalls = 0;
	const created: http2.ClientHttp2Session[] = [];
	const connect = () => {
		connectCalls += 1;
		const session = fakeSession();
		created.push(session);
		return session;
	};

	const first = acquireCursorHttp2Session(origin, { proxied: false, connect });
	const second = acquireCursorHttp2Session(origin, { proxied: false, connect });
	assert.equal(second, first);
	assert.equal(connectCalls, 1);

	discardCursorHttp2Session(first);

	const third = acquireCursorHttp2Session(origin, { proxied: false, connect });
	assert.notEqual(third, first);
	assert.equal(connectCalls, 2);

	discardCursorHttp2Session(third);
	for (const session of created) {
		assert.equal(session.closed, true, "测试结束时不应留下未关闭的假会话");
	}
});

test("代理会话不入池，后续直连不会拿到代理会话", () => {
	const origin = "https://h2-pool-proxied.test";
	let connectCalls = 0;
	const connect = () => {
		connectCalls += 1;
		return fakeSession();
	};

	const proxiedA = acquireCursorHttp2Session(origin, { proxied: true, connect });
	const proxiedB = acquireCursorHttp2Session(origin, { proxied: true, connect });
	assert.notEqual(proxiedA, proxiedB);
	assert.equal(connectCalls, 2);

	const direct = acquireCursorHttp2Session(origin, { proxied: false, connect });
	assert.notEqual(direct, proxiedA);
	assert.notEqual(direct, proxiedB);
	assert.equal(connectCalls, 3);

	discardCursorHttp2Session(proxiedA);
	discardCursorHttp2Session(proxiedB);
	discardCursorHttp2Session(direct);
	assert.equal(proxiedA.closed, true);
	assert.equal(proxiedB.closed, true);
	assert.equal(direct.closed, true);
});
