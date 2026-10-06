import assert from "node:assert/strict";
import test from "node:test";
import { resetApiProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { installCursorProvider } from "./install.ts";

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
