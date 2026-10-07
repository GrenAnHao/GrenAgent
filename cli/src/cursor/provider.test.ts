import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { resetApiProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { installCursorProvider } from "./install.ts";

function cursorModel(id: string): Model<"cursor-agent"> {
	return { id, provider: "cursor", api: "cursor-agent", baseUrl: "https://api2.cursor.sh" } as Model<"cursor-agent">;
}

function fakeStream(signal?: AbortSignal): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const finish = () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			api: "cursor-agent",
			provider: "cursor",
			model: "composer-2.5",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "aborted", message });
	};
	if (signal?.aborted) {
		finish();
		return stream;
	}
	signal?.addEventListener("abort", finish, { once: true });
	return stream;
}

test("cursor-agent 走到本地流，未知模型在开流前失败", async () => {
  resetApiProviders();
  let opened = 0;
  installCursorProvider({
    streamCursor: () => { opened += 1; throw new Error("should not open"); },
    registerNativeProvider: () => {},
  });
  const model = { id: "missing", provider: "cursor", api: "cursor-agent", baseUrl: "https://api2.cursor.sh" };
  await assert.rejects(() => streamSimple(model as never, { messages: [] } as never).result(), /unknown model/i);
  assert.equal(opened, 0);
});

test("openai-responses 的实现不换成 Cursor", async () => {
  resetApiProviders();
  const { getApiProvider, registerBuiltInApiProviders } = await import("@earendil-works/pi-ai/compat");
  registerBuiltInApiProviders();
  const before = getApiProvider("openai-responses")?.streamSimple;
  installCursorProvider({
    streamCursor: () => { throw new Error("cursor"); },
    registerNativeProvider: () => {},
  });
  assert.equal(getApiProvider("openai-responses")?.streamSimple, before);
  assert.equal(typeof getApiProvider("cursor-agent")?.streamSimple, "function");
  assert.notEqual(getApiProvider("cursor-agent")?.streamSimple, before);
});

test("原生供应商列出 composer-2.5 与 composer-2.5-fast", () => {
  resetApiProviders();
  let ids: string[] = [];
  installCursorProvider({
    streamCursor: () => { throw new Error("cursor"); },
    registerNativeProvider: (provider) => {
      ids = provider.getModels().map((model) => model.id);
    },
  });
  assert.ok(ids.includes("composer-2.5"));
  assert.ok(ids.includes("composer-2.5-fast"));
});

test("用户中止会取消这一轮并且没有第二轮", async () => {
	resetApiProviders();
	const signals: AbortSignal[] = [];
	installCursorProvider({
		streamCursor: (_model, _context, options) => {
			signals.push(options?.signal as AbortSignal);
			return fakeStream(options?.signal);
		},
		registerNativeProvider: () => {},
	});
	const controller = new AbortController();
	const stream = streamSimple(cursorModel("composer-2.5"), { messages: [] } as never, {
		signal: controller.signal,
	});
	controller.abort();
	const message = await stream.result();
	assert.equal(message.stopReason, "aborted");
	assert.equal(signals.length, 1);
	assert.equal(signals[0]?.aborted, true);
});

test("signal 已 abort 时不开 Cursor 流", async () => {
	resetApiProviders();
	let opened = 0;
	installCursorProvider({
		streamCursor: () => {
			opened += 1;
			throw new Error("should not open");
		},
		registerNativeProvider: () => {},
	});
	const controller = new AbortController();
	controller.abort();
	const message = await streamSimple(cursorModel("composer-2.5"), { messages: [] } as never, {
		signal: controller.signal,
	}).result();
	assert.equal(opened, 0);
	assert.equal(message.stopReason, "aborted");
});
