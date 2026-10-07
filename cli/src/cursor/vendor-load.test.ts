import assert from "node:assert/strict";
import test from "node:test";

test("复制来的客户端导出开流函数，并且 composer-2.5 带 fast=false", async () => {
  const cursor = await import("./vendor/providers/cursor.ts");
  assert.equal(typeof cursor.streamCursor, "function");
  const { cursorModelParameters } = await import("./vendor/catalog/compat/behavior.ts");
  const parameters = cursorModelParameters("composer-2.5");
  assert.deepEqual(parameters, [{ id: "fast", value: "false" }]);
  const fast = cursorModelParameters("composer-2.5-fast");
  assert.deepEqual(fast, []);
});
