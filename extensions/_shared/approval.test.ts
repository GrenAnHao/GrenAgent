import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_LABELS,
  approvalPolicyConfigKey,
  getApprovalPolicy,
  parseApproval,
  setApprovalPolicy,
  __resetApprovalForTest,
} from "./approval.js";
import { __resetForTest } from "./runtime-config.js";
import { runInWorkspace } from "./workspace-context.js";

const directories: string[] = [];

beforeEach(() => __resetApprovalForTest());

afterEach(() => {
  __resetForTest();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.PI_RUNTIME_CONFIG;
});

describe("approval policy", () => {
  it("defaults to auto", () => {
    expect(getApprovalPolicy()).toBe("auto");
  });
  it("set/get round-trip", () => {
    setApprovalPolicy("ask");
    expect(getApprovalPolicy()).toBe("ask");
  });
  it("parse accepts known values (case-insensitive), rejects others", () => {
    expect(parseApproval("full")).toBe("full");
    expect(parseApproval("ASK")).toBe("ask");
    expect(parseApproval("  auto ")).toBe("auto");
    expect(parseApproval("xx")).toBeUndefined();
    expect(parseApproval(undefined)).toBeUndefined();
  });
  it("has zh labels for all 3", () => {
    expect(Object.keys(APPROVAL_LABELS).sort()).toEqual(["ask", "auto", "full"]);
  });
});

describe("getApprovalPolicy 分键", () => {
  it("set/get 按 cwd 隔离", () => {
    setApprovalPolicy("ask", "D:/a");
    setApprovalPolicy("full", "D:/b");
    expect(getApprovalPolicy("D:/a")).toBe("ask");
    expect(getApprovalPolicy("D:/b")).toBe("full");
  });

  it("无参时读 ALS cwd", async () => {
    setApprovalPolicy("ask", "D:/a");
    setApprovalPolicy("full", "D:/b");
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => {
        expect(getApprovalPolicy()).toBe("ask");
      },
    );
  });

  it("live 文件键按传入 cwd 匹配，不读 process.cwd()", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-cwd-"));
    directories.push(directory);
    const runtime = join(directory, "runtime-settings.json");
    const target = "D:/proj-a";
    process.env.PI_RUNTIME_CONFIG = runtime;
    await writeFile(runtime, JSON.stringify({ [approvalPolicyConfigKey(target)]: "full" }));
    __resetForTest();
    setApprovalPolicy("ask", target);
    expect(getApprovalPolicy(target)).toBe("full");
    expect(getApprovalPolicy("D:/other")).not.toBe("full");
  });
});
