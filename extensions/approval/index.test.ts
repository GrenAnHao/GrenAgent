import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  refreshConfig: vi.fn(),
  setRuntimeConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import {
  approvalPolicyConfigKey,
  getApprovalPolicy,
  setApprovalPolicy,
  __resetApprovalForTest,
} from "../_shared/approval.js";
import { getConfig, setRuntimeConfig, watchConfig } from "../_shared/runtime-config.js";
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

const ctx = (entries: SessionEntry[] = [], cwd?: string, sessionId?: string) => ({
  sessionManager: { getEntries: () => entries, ...(sessionId ? { getSessionId: () => sessionId } : {}) },
  ui: { setStatus: vi.fn(), notify: vi.fn() },
  ...(cwd ? { cwd } : {}),
});

beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalForTest();
});

describe("approval extension", () => {
  it("does not register a slash command; desktop writes runtime config", () => {
    const cmds: string[] = [];
    const pi = {
      registerCommand: (n: string) => cmds.push(n),
      on: () => {},
      appendEntry: () => {},
    };
    approval(pi as unknown as Parameters<typeof approval>[0]);
    expect(cmds).toEqual([]);
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

  it("session_start 不覆盖该 cwd 已写入的 live", async () => {
    setApprovalPolicy("full", "D:/proj-a");
    vi.mocked(getConfig).mockReturnValue("ask");
    await loadSessionStart()(
      {},
      ctx([{ type: "custom", customType: "approval", data: { policy: "ask" } }], "D:/proj-a"),
    );
    expect(getApprovalPolicy("D:/proj-a")).toBe("full");
  });
});

describe("approval cwd binding", () => {
  it("watchConfig 在 session_start 之后按 ctx.cwd 读键，不读 process.cwd()", async () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    approval({
      registerCommand: () => {},
      on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[ev] = h;
      },
      appendEntry: () => {},
    } as never);
    await handlers.session_start?.({}, ctx([], "D:/proj-a"));
    const key = approvalPolicyConfigKey("D:/proj-a");
    for (const cb of subscribers) cb({ [key]: "ask" });
    expect(getApprovalPolicy("D:/proj-a")).toBe("ask");
    expect(getApprovalPolicy("D:/other")).toBe("auto");
  });

  it("activate 不写 runtime：档位只由宿主 agent_set_approval 写入", async () => {
    approval({
      registerCommand: () => {},
      on: () => {},
      appendEntry: () => {},
    } as never);
    expect(setRuntimeConfig).not.toHaveBeenCalled();
  });
});

describe("approval per session", () => {
  it("每个会话钉住自己的档：会话条目优先，换会话不沿用上一个", async () => {
    vi.mocked(getConfig).mockReturnValue(undefined);
    const start = loadSessionStart();
    const a = ctx([{ type: "custom", customType: "session-controls", data: { approval: "readonly" } }], "D:/p", "sa");
    await start({}, a);
    expect(getApprovalPolicy("D:/p", "sa")).toBe("readonly");
    expect(a.ui.setStatus).toHaveBeenCalledWith("approval-policy", "readonly");

    const b = ctx([], "D:/p", "sb");
    await start({}, b);
    expect(getApprovalPolicy("D:/p", "sb")).toBe("auto");
    expect(b.ui.setStatus).toHaveBeenCalledWith("approval-policy", "auto");
    expect(getApprovalPolicy("D:/p", "sa")).toBe("readonly");
  });

  it("项目默认档变化不改已打开会话", async () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    approval({
      registerCommand: () => {},
      on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[ev] = h;
      },
      appendEntry: () => {},
    } as never);
    await handlers.session_start?.({}, ctx([], "D:/p", "sa"));
    for (const cb of subscribers) cb({ [approvalPolicyConfigKey("D:/p")]: "full" });
    expect(getApprovalPolicy("D:/p", "sa")).toBe("auto");
    expect(getApprovalPolicy("D:/p", "new")).toBe("full");
  });
});
