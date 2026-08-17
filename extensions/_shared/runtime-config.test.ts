import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSensitiveProcessConfig,
  getConfig,
  getAllConfig,
  __resetForTest,
} from "./runtime-config.js";

const dirs: string[] = [];
function fileWith(obj: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rtcfg-"));
  dirs.push(dir);
  const p = join(dir, "runtime-settings.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
afterEach(() => {
  __resetForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PI_RUNTIME_CONFIG;
  delete process.env.SOME_KEY;
  delete process.env.TDAI_MEMORY_API_KEY;
  delete process.env.TDAI_MEMORY_USER_KEY;
});

describe("runtime-config", () => {
  it("reads value from runtime file", () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({ SOME_KEY: "from-file" });
    expect(getConfig("SOME_KEY")).toBe("from-file");
  });
  it("falls back to process.env when file missing key", () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({});
    process.env.SOME_KEY = "from-env";
    expect(getConfig("SOME_KEY")).toBe("from-env");
  });
  it("falls back to process.env when no PI_RUNTIME_CONFIG", () => {
    process.env.SOME_KEY = "env-only";
    expect(getConfig("SOME_KEY")).toBe("env-only");
  });
  it("getAllConfig merges env + file (file wins)", () => {
    process.env.SOME_KEY = "env";
    process.env.PI_RUNTIME_CONFIG = fileWith({ SOME_KEY: "file" });
    expect(getAllConfig().SOME_KEY).toBe("file");
  });
  it("keeps TencentDB credentials in-process without exposing them to child environments", () => {
    process.env.TDAI_MEMORY_API_KEY = "gateway-secret";
    process.env.TDAI_MEMORY_USER_KEY = "user-secret";

    captureSensitiveProcessConfig();

    expect(getConfig("TDAI_MEMORY_API_KEY")).toBe("gateway-secret");
    expect(getConfig("TDAI_MEMORY_USER_KEY")).toBe("user-secret");
    expect(process.env.TDAI_MEMORY_API_KEY).toBeUndefined();
    expect(process.env.TDAI_MEMORY_USER_KEY).toBeUndefined();
    expect(getAllConfig()).not.toHaveProperty("TDAI_MEMORY_API_KEY");
    expect(getAllConfig()).not.toHaveProperty("TDAI_MEMORY_USER_KEY");
  });

  it("filters TencentDB credentials loaded from the runtime config snapshot", () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({
      SOME_KEY: "visible",
      TDAI_MEMORY_API_KEY: "gateway-secret",
      TDAI_MEMORY_USER_KEY: "user-secret",
    });

    expect(getAllConfig()).toMatchObject({ SOME_KEY: "visible" });
    expect(getAllConfig()).not.toHaveProperty("TDAI_MEMORY_API_KEY");
    expect(getAllConfig()).not.toHaveProperty("TDAI_MEMORY_USER_KEY");
  });
});
