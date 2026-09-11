import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkerMode } from "./pi-worker.js";

test("--mode json 被接受", () => {
  assert.equal(resolveWorkerMode(["--mode", "json", "-p"]), "json");
});

test("--mode rpc 被拒绝", () => {
  assert.throws(() => resolveWorkerMode(["--mode", "rpc"]), /does not support rpc/);
});

test("无 --mode 时按 print 路径", () => {
  assert.equal(resolveWorkerMode(["-p", "hello"]), "print");
});

test("--mode 后缺参数按 print", () => {
  assert.equal(resolveWorkerMode(["--mode"]), "print");
});
