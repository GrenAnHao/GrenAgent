import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { __resetForTest, getConfig } from "../../extensions/_shared/runtime-config.js";
import { bootstrapSidecar } from "./bootstrap.js";

test("bootstrap does not expose sensitive process configuration", async () => {
  __resetForTest();
  process.env.TDAI_MEMORY_API_KEY = "gateway-secret";
  process.env.TDAI_MEMORY_USER_KEY = "user-secret";
  let ran = false;

  await bootstrapSidecar(async () => {
    assert.equal(process.env.TDAI_MEMORY_API_KEY, "gateway-secret");
    assert.equal(process.env.TDAI_MEMORY_USER_KEY, "user-secret");
    // 敏感键（TDAI_* / TENCENTDB_*）只留在 process.env，不进入运行时配置。
    assert.equal(getConfig("TDAI_MEMORY_API_KEY"), undefined);
    assert.equal(getConfig("TDAI_MEMORY_USER_KEY"), undefined);
    return {
      run: async () => {
        ran = true;
      },
    };
  });

  assert.equal(ran, true);
  __resetForTest();
  delete process.env.TDAI_MEMORY_API_KEY;
  delete process.env.TDAI_MEMORY_USER_KEY;
});

test("the executable entrypoint does not statically import Pi or extensions", async () => {
  const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']@earendil-works\/pi-coding-agent["']/);
  assert.doesNotMatch(source, /from\s+["']\.\.\/\.\.\/extensions\/index\.js["']/);
  assert.match(source, /import\(["']\.\/runtime\.js["']\)/);
});
