import assert from "node:assert/strict";
import { test } from "node:test";
import { toJsonEvent } from "./json-event.js";

test("message_update 剥掉 message 快照，保留 usage", () => {
  const usage = { input: 10, output: 20 };
  const event = {
    type: "message_update",
    message: { role: "assistant", id: "m1", content: [{ type: "text", text: "累积全文" }], usage },
    assistantMessageEvent: { type: "text_delta", delta: "文" },
  };
  const result = toJsonEvent(event as never) as Record<string, unknown>;
  assert.equal(result.type, "message_update");
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.assistantMessageEvent, { type: "text_delta", delta: "文" });
  assert.ok(!("message" in result), "message 字段必须被剥掉");
});

test("toolcall_start 剥掉 partial，补 id 与 toolName", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", usage: { input: 1, output: 2 } },
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: { content: [{ type: "toolCall", id: "call_1", name: "read_file" }] },
    },
  };
  const inner = (toJsonEvent(event as never) as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>;
  assert.equal(inner.id, "call_1");
  assert.equal(inner.toolName, "read_file");
  assert.equal(inner.contentIndex, 0);
  assert.ok(!("partial" in inner), "partial 必须被剥掉");
});

test("非 toolcall_start 的带 partial 事件也剥掉 partial", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { content: [] } },
  };
  const inner = (toJsonEvent(event as never) as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>;
  assert.equal(inner.type, "text_start");
  assert.ok(!("partial" in inner), "任何带 partial 的事件都要剥掉");
});

test("非 message_update 事件原样返回", () => {
  const event = { type: "agent_end", messages: [], willRetry: false };
  assert.equal(toJsonEvent(event as never), event);
});

test("toolcall_start 指向非 toolCall 内容时抛错", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "text", text: "x" }] } },
  };
  assert.throws(() => toJsonEvent(event as never), /is not a tool call/);
});

test("message_update 的 message 非 assistant 时抛错", () => {
  const event = { type: "message_update", message: { role: "user" }, assistantMessageEvent: { type: "text_delta", delta: "x" } };
  assert.throws(() => toJsonEvent(event as never), /not an assistant message/);
});
