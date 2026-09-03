import assert from "node:assert/strict";
import test from "node:test";

test("runtime loads against the installed pi coding agent SDK", async () => {
  const runtime = await import("./runtime.js");

  assert.equal(typeof runtime.run, "function");
});
