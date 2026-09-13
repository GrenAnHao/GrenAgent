import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentError } from "./inbox.js";

const activation = vi.hoisted(() => ({
  getActivation: vi.fn(),
  deliverToChild: vi.fn(),
  interruptChild: vi.fn(),
  coldResumeAndDeliver: vi.fn(),
  authorizeParent: vi.fn(),
}));

const parentHost = vi.hoisted(() => ({
  lookupParentHost: vi.fn(),
}));

const control = vi.hoisted(() => ({
  getRegistry: vi.fn(),
}));

vi.mock("./activation.js", () => ({
  getActivation: (...args: unknown[]) => activation.getActivation(...args),
  deliverToChild: (...args: unknown[]) => activation.deliverToChild(...args),
  interruptChild: (...args: unknown[]) => activation.interruptChild(...args),
  coldResumeAndDeliver: (...args: unknown[]) => activation.coldResumeAndDeliver(...args),
  authorizeParent: (...args: unknown[]) => activation.authorizeParent(...args),
}));

vi.mock("./parent-host.js", () => ({
  lookupParentHost: (...args: unknown[]) => parentHost.lookupParentHost(...args),
}));

vi.mock("./controlPlane.js", () => ({
  getRegistry: (...args: unknown[]) => control.getRegistry(...args),
}));

import { continuableReturnGuidance, registerAdjacentTools } from "./adjacent-tools.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: null,
  ctx: { cwd: string; sessionManager: { getSessionId: () => string } },
) => Promise<ToolResult>;

function loadAdjacent(): { send: Execute; interrupt: Execute } {
  const tools = new Map<string, { name: string; execute: Execute }>();
  registerAdjacentTools({
    registerTool: (t: { name: string; execute: Execute }) => {
      tools.set(t.name, t);
    },
  } as never);
  return {
    send: tools.get("send_message")!.execute,
    interrupt: tools.get("interrupt_agent")!.execute,
  };
}

function ctx(sessionId: string, cwd = "/ws") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function childAct(over: Record<string, unknown> = {}) {
  return {
    childId: "sa-1",
    parentSessionId: "p1",
    parentSessionPath: "/ws/parent.jsonl",
    workspace: "/ws",
    session: {
      isStreaming: false,
      messages: [
        { role: "assistant", id: "a-1" },
        { role: "user", id: "um-1" },
        { role: "assistant", id: "a-2" },
      ],
    },
    ...over,
  };
}

describe("adjacent-tools", () => {
  beforeEach(() => {
    activation.getActivation.mockReset();
    activation.deliverToChild.mockReset();
    activation.interruptChild.mockReset();
    activation.coldResumeAndDeliver.mockReset();
    activation.authorizeParent.mockReset();
    parentHost.lookupParentHost.mockReset();
    control.getRegistry.mockReset();
    activation.getActivation.mockReturnValue(undefined);
    activation.coldResumeAndDeliver.mockResolvedValue(undefined);
    control.getRegistry.mockReturnValue({ get: () => undefined });
  });

  it("continuableReturnGuidance locks the parent return sentence", () => {
    expect(continuableReturnGuidance("p1")).toBe(
      'Your parent agent id is "p1". Before you finish, send your result to that agent with send_message({ agent_id: "p1", message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.',
    );
    expect(continuableReturnGuidance('foo"bar')).toContain(JSON.stringify('foo"bar'));
  });

  it("父→直接子：deliverToChild 正文带 senderId，回执 delivered", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) => (id === "sa-1" ? childAct() : undefined));
    const r = await send("t1", { agent_id: "sa-1", message: "hi" }, null, null, ctx("p1"));
    expect(activation.deliverToChild).toHaveBeenCalledWith(
      "sa-1",
      "Agent p1 sent a message: hi",
      "followUp",
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain("message delivered to agent sa-1");
    expect(r.details?.messageId).toBe("um-1");
  });

  it("父→驻留子 isStreaming 时 deliver 为 steer", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) =>
      id === "sa-1" ? childAct({ session: { isStreaming: true, messages: [] } }) : undefined,
    );
    await send("t1b", { agent_id: "sa-1", message: "hi" }, null, null, ctx("p1"));
    expect(activation.deliverToChild).toHaveBeenCalledWith(
      "sa-1",
      "Agent p1 sent a message: hi",
      "steer",
    );
  });

  it("父→无关 id → isError，文案含未送达", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) =>
      id === "sa-other" ? childAct({ childId: "sa-other", parentSessionId: "p-other" }) : undefined,
    );
    const r = await send("t2", { agent_id: "sa-other", message: "hi" }, null, null, ctx("p1"));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("未送达");
    expect(activation.deliverToChild).not.toHaveBeenCalled();
    expect(activation.coldResumeAndDeliver).not.toHaveBeenCalled();
  });

  it("驻留子→父：host.prompt（非 sendMessage / 非 subagent-settled）；busy→steer，idle→followUp", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) => (id === "sa-1" ? childAct() : undefined));
    const prompt = vi.fn();
    const sendMessage = vi.fn();
    let busy = true;
    parentHost.lookupParentHost.mockReturnValue({
      sessionId: "p1",
      sessionPath: "/ws/parent.jsonl",
      workspace: "/ws",
      isBusy: () => busy,
      isDraining: () => false,
      sendMessage,
      prompt,
    });

    const busyResult = await send("t3a", { agent_id: "p1", message: "hi" }, null, null, ctx("sa-1"));
    expect(busyResult.isError).toBeFalsy();
    expect(prompt).toHaveBeenCalledWith("Agent sa-1 sent a message: hi", "steer");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(prompt.mock.calls)).not.toContain("subagent-settled");

    busy = false;
    prompt.mockClear();
    await send("t3b", { agent_id: "p1", message: "hi" }, null, null, ctx("sa-1"));
    expect(prompt).toHaveBeenCalledWith("Agent sa-1 sent a message: hi", "followUp");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("子无 Activation（已 dispose）→父 → PARENT_UNAVAILABLE / 未送达", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockReturnValue(undefined);
    parentHost.lookupParentHost.mockReturnValue(undefined);
    const r = await send("t4", { agent_id: "p1", message: "done" }, null, null, ctx("sa-1"));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("未送达");
    expect(r.content[0]?.text).toContain("PARENT_UNAVAILABLE");
    expect(parentHost.lookupParentHost).not.toHaveBeenCalled();
    expect(activation.coldResumeAndDeliver).not.toHaveBeenCalled();
  });

  it("同级 → UNAUTHORIZED / 未送达", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) => {
      if (id === "sa-1") return childAct({ childId: "sa-1" });
      if (id === "sa-2") return childAct({ childId: "sa-2" });
      return undefined;
    });
    const r = await send("t5", { agent_id: "sa-2", message: "hi" }, null, null, ctx("sa-1"));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("未送达");
    expect(r.content[0]?.text).toContain("UNAUTHORIZED");
    expect(activation.deliverToChild).not.toHaveBeenCalled();
  });

  it("无 Activation、registry 有 sessionPath → 调 coldResumeAndDeliver", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockReturnValue(undefined);
    control.getRegistry.mockReturnValue({
      get: (id: string) => (id === "sa-1" ? { sessionPath: "/ws/child.jsonl" } : undefined),
    });
    const r = await send("t6", { agent_id: "sa-1", message: "hi" }, null, null, ctx("p1"));
    expect(activation.coldResumeAndDeliver).toHaveBeenCalledWith(
      "sa-1",
      "/ws/child.jsonl",
      "Agent p1 sent a message: hi",
      "followUp",
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain("message delivered to agent sa-1");
  });

  it("coldResumeAndDeliver 抛 NOT_RESUMABLE（one-shot）→ isError 未送达", async () => {
    const { send } = loadAdjacent();
    activation.getActivation.mockReturnValue(undefined);
    control.getRegistry.mockReturnValue({
      get: (id: string) => (id === "sa-1" ? { sessionPath: "/ws/child.jsonl" } : undefined),
    });
    activation.coldResumeAndDeliver.mockRejectedValue(
      new SubagentError("child sa-1 is not resumable", "NOT_RESUMABLE"),
    );
    const r = await send("t7", { agent_id: "sa-1", message: "hi" }, null, null, ctx("p1"));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("未送达");
    expect(r.content[0]?.text).toContain("NOT_RESUMABLE");
  });

  it("interrupt 不存在的 id → interrupt requested（非 error）", async () => {
    const { interrupt } = loadAdjacent();
    activation.getActivation.mockReturnValue(undefined);
    const r = await interrupt("t8", { agent_id: "sa-missing" }, null, null, ctx("p1"));
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toBe("interrupt requested for agent sa-missing");
    expect(activation.interruptChild).not.toHaveBeenCalled();
  });

  it("interrupt 直接父对驻留子会调 interruptChild", async () => {
    const { interrupt } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) => (id === "sa-1" ? childAct() : undefined));
    const r = await interrupt("t9", { agent_id: "sa-1" }, null, null, ctx("p1"));
    expect(activation.interruptChild).toHaveBeenCalledWith("sa-1");
    expect(r.isError).toBeFalsy();
  });

  it("自己 interrupt 自己 isError", async () => {
    const { interrupt } = loadAdjacent();
    activation.getActivation.mockImplementation((id: string) => (id === "sa-1" ? childAct() : undefined));
    const r = await interrupt("t10", { agent_id: "sa-1" }, null, null, ctx("sa-1"));
    expect(r.isError).toBe(true);
    expect(activation.interruptChild).not.toHaveBeenCalled();
  });
});
