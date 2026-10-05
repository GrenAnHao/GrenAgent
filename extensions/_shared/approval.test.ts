import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_LABELS,
  approvalPolicyConfigKey,
  getApprovalPolicy,
  hasApprovalPolicy,
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
  it("has zh labels for all 5", () => {
    expect(Object.keys(APPROVAL_LABELS).sort()).toEqual([
      "ask", "auto", "full", "readonly", "workspace",
    ]);
  });
  it("parse accepts the two new keys", () => {
    expect(parseApproval("readonly")).toBe("readonly");
    expect(parseApproval("WORKSPACE")).toBe("workspace");
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

  it("运行时只读内存：盘上的 live 键盖不过 setApprovalPolicy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-cwd-"));
    directories.push(directory);
    const runtime = join(directory, "runtime-settings.json");
    const target = "D:/proj-a";
    process.env.PI_RUNTIME_CONFIG = runtime;
    await writeFile(runtime, JSON.stringify({ [approvalPolicyConfigKey(target)]: "full" }));
    __resetForTest();
    setApprovalPolicy("ask", target);
    expect(getApprovalPolicy(target)).toBe("ask");
    expect(getApprovalPolicy("D:/other")).toBe("auto");
  });

  it("hasApprovalPolicy 区分未写入与显式默认档", () => {
    expect(hasApprovalPolicy("D:/a")).toBe(false);
    expect(getApprovalPolicy("D:/a")).toBe("auto");
    setApprovalPolicy("auto", "D:/a");
    expect(hasApprovalPolicy("D:/a")).toBe(true);
    expect(hasApprovalPolicy("D:/b")).toBe(false);
  });
});

describe("getApprovalPolicy 按会话", () => {
  it("会话档优先于项目默认，未写过的会话回退项目默认", () => {
    setApprovalPolicy("auto", "D:/a");
    setApprovalPolicy("full", "D:/a", "s1");
    setApprovalPolicy("readonly", "D:/a", "s2");
    expect(getApprovalPolicy("D:/a", "s1")).toBe("full");
    expect(getApprovalPolicy("D:/a", "s2")).toBe("readonly");
    expect(getApprovalPolicy("D:/a", "s3")).toBe("auto");
    expect(hasApprovalPolicy("D:/a", "s3")).toBe(false);
  });

  it("改项目默认不影响已钉住的会话", () => {
    setApprovalPolicy("ask", "D:/a", "s1");
    setApprovalPolicy("full", "D:/a");
    expect(getApprovalPolicy("D:/a", "s1")).toBe("ask");
  });

  it("无参时读 ALS 里的 sessionId", async () => {
    setApprovalPolicy("auto", "D:/a");
    setApprovalPolicy("readonly", "D:/a", "s1");
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {}, sessionId: () => "s1" },
      async () => {
        expect(getApprovalPolicy()).toBe("readonly");
      },
    );
  });
});
