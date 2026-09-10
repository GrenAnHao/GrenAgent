import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfig,
  getAllConfig,
  __resetForTest,
} from "./runtime-config.js";
import { runInWorkspace } from "./workspace-context.js";

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
  delete process.env.AGENT_DATA_ENDPOINT;
  delete process.env.ENV_ONLY;
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
  it("rejects legacy provider credentials from process configuration", () => {
    process.env.TDAI_MEMORY_API_KEY = "gateway-secret";
    process.env.TDAI_MEMORY_USER_KEY = "user-secret";

    expect(getConfig("TDAI_MEMORY_API_KEY")).toBeUndefined();
    expect(getConfig("TDAI_MEMORY_USER_KEY")).toBeUndefined();
    expect(process.env.TDAI_MEMORY_API_KEY).toBe("gateway-secret");
    expect(process.env.TDAI_MEMORY_USER_KEY).toBe("user-secret");
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

describe("getConfig 与 workspace 上下文", () => {
  it("ALS 内的值优先于 process.env 与落盘文件", async () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({ AGENT_DATA_ENDPOINT: "from-file" });
    process.env.AGENT_DATA_ENDPOINT = "from-env";
    try {
      await runInWorkspace(
        { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { AGENT_DATA_ENDPOINT: "from-als" } },
        async () => {
          expect(getConfig("AGENT_DATA_ENDPOINT")).toBe("from-als");
        },
      );
      expect(getConfig("AGENT_DATA_ENDPOINT")).toBe("from-file");
    } finally {
      delete process.env.AGENT_DATA_ENDPOINT;
    }
  });

  it("两个 workspace 并发读到各自的值", async () => {
    const read = (workspace: string, endpoint: string) =>
      runInWorkspace(
        { origin: "main", workspace, cwd: workspace, config: { AGENT_DATA_ENDPOINT: endpoint } },
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          return getConfig("AGENT_DATA_ENDPOINT");
        },
      );
    const [a, b] = await Promise.all([read("D:/a", "endpoint-a"), read("D:/b", "endpoint-b")]);
    expect(a).toBe("endpoint-a");
    expect(b).toBe("endpoint-b");
  });

  it("ALS 未定义的 key 仍回退文件再回退 env", async () => {
    process.env.PI_RUNTIME_CONFIG = fileWith({ FILE_ONLY: "file" });
    process.env.ENV_ONLY = "env";
    try {
      await runInWorkspace(
        { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { AGENT_DATA_ENDPOINT: "x" } },
        async () => {
          expect(getConfig("FILE_ONLY")).toBe("file");
          expect(getConfig("ENV_ONLY")).toBe("env");
        },
      );
    } finally {
      delete process.env.ENV_ONLY;
    }
  });

  it("敏感前缀在 ALS 内同样被拦截", async () => {
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { TDAI_SECRET: "leak" } },
      async () => {
        expect(getConfig("TDAI_SECRET")).toBeUndefined();
      },
    );
  });

  it("getAllConfig 让 ALS 覆盖 file/env", async () => {
    process.env.SOME_KEY = "env";
    process.env.PI_RUNTIME_CONFIG = fileWith({ SOME_KEY: "file" });
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: { SOME_KEY: "als" } },
      async () => {
        expect(getAllConfig().SOME_KEY).toBe("als");
      },
    );
  });
});
