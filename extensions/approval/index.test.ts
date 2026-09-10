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

const ctx = (entries: SessionEntry[] = [], cwd?: string) => ({
  sessionManager: { getEntries: () => entries },
  ui: { setStatus: vi.fn(), notify: vi.fn() },
  ...(cwd ? { cwd } : {}),
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

  it("/approval 把档位写到 ctx.cwd 键", async () => {
    let handler: ((args: string, ctx: { cwd: string; ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
    approval({
      registerCommand: (_n: string, spec: { handler: typeof handler }) => {
        handler = spec.handler;
      },
      on: () => {},
      appendEntry: () => {},
    } as never);
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    await handler!("full", { cwd: "D:/proj-a", ui });
    expect(setRuntimeConfig).toHaveBeenCalledWith(approvalPolicyConfigKey("D:/proj-a"), "full");
  });
});
