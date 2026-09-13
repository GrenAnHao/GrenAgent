import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离工作流注册的副作用（seed agents 会写 ~/.pi）；本文件只验证 session_start → 孤儿回收这条线。
vi.mock("./workflows.js", () => ({ registerWorkflows: () => {} }));
// cancel 改为 spy：既能断言「启动即装取消监听」，又避免真实 fs.watch 在测试里泄漏句柄。
const { installCancelWatcher, cancelSubAgent } = vi.hoisted(() => ({
  installCancelWatcher: vi.fn(),
  cancelSubAgent: vi.fn(),
}));
vi.mock("./cancel.js", () => ({ installCancelWatcher, cancelSubAgent }));

import { SessionManager } from "@earendil-works/pi-coding-agent";
import multiAgent from "./index.js";
import { SubAgentRegistry } from "./registry.js";

type SessionStartHandler = (event: unknown, ctx: { cwd: string }) => void;

// 加载扩展并捕获它注册的 session_start handler（其余生命周期/工具注册都吞掉）。
function loadSessionStartHandler(): SessionStartHandler {
  let handler: SessionStartHandler | undefined;
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    sendUserMessage: () => {},
    on: (event: string, h: SessionStartHandler) => {
      if (event === "session_start") handler = h;
    },
  };
  multiAgent(pi as unknown as Parameters<typeof multiAgent>[0]);
  if (!handler) throw new Error("session_start handler was not registered");
  return handler;
}

const dirs: string[] = [];
function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sa-restart-"));
  dirs.push(dir);
  return dir;
}

// 在 <cwd>/.pi/subagents/registry.db 写一条上个进程遗留的 running 行（模拟重启前的子代理）。
function seedRunningRow(cwd: string, id: string, sessionPath?: string | null): void {
  const reg = new SubAgentRegistry(join(cwd, ".pi", "subagents", "registry.db"));
  reg.load();
  reg.create({ id, task: "leftover from previous process", sessionPath });
  reg.close();
}

function readRow(cwd: string, id: string): { status: string; error: string | null } | undefined {
  const reg = new SubAgentRegistry(join(cwd, ".pi", "subagents", "registry.db"));
  reg.load();
  const row = reg.get(id);
  reg.close();
  return row ? { status: row.status, error: row.error } : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PI_IS_SUBAGENT;
});

afterEach(() => {
  delete process.env.PI_IS_SUBAGENT;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* sqlite handle may linger on Windows; best-effort cleanup */
    }
  }
});

describe("multi-agent · reap orphans on session_start (restart recovery)", () => {
  it("marks a leftover running row as orphaned error and installs the cancel watcher", () => {
    const cwd = tmpCwd();
    seedRunningRow(cwd, "sa-orphan00");

    loadSessionStartHandler()({}, { cwd });

    const row = readRow(cwd, "sa-orphan00");
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("orphaned");
    expect(installCancelWatcher).toHaveBeenCalledWith(cwd, expect.any(Function));
  });

  it("does NOT reap inside a sub-agent process (PI_IS_SUBAGENT=1)", () => {
    const cwd = tmpCwd();
    seedRunningRow(cwd, "sa-orphan00");

    process.env.PI_IS_SUBAGENT = "1";
    loadSessionStartHandler()({}, { cwd });

    expect(readRow(cwd, "sa-orphan00")?.status).toBe("running");
    expect(installCancelWatcher).not.toHaveBeenCalled();
  });

  it("marks leftover continuable jsonl as done after session_start", () => {
    const cwd = tmpCwd();
    const sm = SessionManager.create(cwd, join(cwd, "sessions"), { id: "sa-cont01" });
    sm.appendCustomEntry("subagent_meta", { mode: "continuable" });
    const sessionPath = sm.getSessionFile();
    if (!sessionPath) throw new Error("session file was not created");
    const header = sm.getHeader();
    const lines = [header, ...sm.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
    writeFileSync(sessionPath, `${lines.join("\n")}\n`);
    seedRunningRow(cwd, "sa-cont01", sessionPath);

    loadSessionStartHandler()({}, { cwd });

    const row = readRow(cwd, "sa-cont01");
    expect(row?.status).toBe("done");
    expect(row?.error).toBe("sidecar restarted");
    expect(installCancelWatcher).toHaveBeenCalledWith(cwd, expect.any(Function));
  });
});
