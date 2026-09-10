import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(), refreshConfig: vi.fn() }));

import {
  approvalPolicyConfigKey,
  getApprovalPolicy,
  __resetApprovalForTest,
} from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import approval from "./index.js";

type SessionStart = (event: unknown, ctx: unknown) => Promise<void>;

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

// 加载扩展并捕获 session_start 处理器（审批策略继承在此发生）。
function loadSessionStart(): SessionStart {
  let handler: SessionStart | undefined;
  const pi = {
    registerCommand: () => {},
    on: (ev: string, h: SessionStart) => {
      if (ev === "session_start") handler = h;
    },
    appendEntry: () => {},
  };
  approval(pi as unknown as Parameters<typeof approval>[0]);
  return handler!;
}

const ctx = (entries: SessionEntry[] = []) => ({
  sessionManager: { getEntries: () => entries },
  ui: { setStatus: vi.fn() },
});

beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalForTest();
});

describe("approval extension", () => {
  it("registers the approval command", () => {
    const cmds: string[] = [];
    const pi = {
      registerCommand: (n: string) => cmds.push(n),
      on: () => {},
      appendEntry: () => {},
    };
    approval(pi as unknown as Parameters<typeof approval>[0]);
    expect(cmds).toEqual(["approval"]);
  });
});

describe("approval policy inheritance on session_start", () => {
  it("inherits APPROVAL_POLICY from config when no session entry (sub-agent inheritance)", async () => {
    vi.mocked(getConfig).mockReturnValue("full");
    await loadSessionStart()({}, ctx([]));
    expect(getApprovalPolicy()).toBe("full");
  });

  it("prefers workspace-scoped live config over a stale session entry", async () => {
    const key = approvalPolicyConfigKey(process.cwd());
    vi.mocked(getConfig).mockImplementation((name: string) => (name === key ? "full" : undefined));
    await loadSessionStart()(
      {},
      ctx([{ type: "custom", customType: "approval", data: { policy: "ask" } }]),
    );
    expect(getApprovalPolicy()).toBe("full");
  });

  it("uses a session entry only when no live runtime config exists", async () => {
    vi.mocked(getConfig).mockReturnValue(undefined);
    await loadSessionStart()(
      {},
      ctx([{ type: "custom", customType: "approval", data: { policy: "ask" } }]),
    );
    expect(getApprovalPolicy()).toBe("ask");
  });

  it("defaults to auto when neither session entry nor APPROVAL_POLICY present", async () => {
    vi.mocked(getConfig).mockReturnValue(undefined);
    await loadSessionStart()({}, ctx([]));
    expect(getApprovalPolicy()).toBe("auto");
  });

  it("ignores an invalid APPROVAL_POLICY value and falls back to auto", async () => {
    vi.mocked(getConfig).mockReturnValue("garbage");
    await loadSessionStart()({}, ctx([]));
    expect(getApprovalPolicy()).toBe("auto");
  });
});
