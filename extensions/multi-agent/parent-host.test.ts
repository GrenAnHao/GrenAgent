import { describe, expect, it, vi } from "vitest";
import {
  lookupParentHost,
  registerParentSessionHost,
  sendSettlementToParent,
  __resetParentHostsForTest,
} from "./parent-host.js";
import { formatSettlementNotice } from "./settlement-notice.js";

describe("parent-host", () => {
  it("looks up by sessionPath and rejects other workspace", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    const unsub = registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    expect(lookupParentHost("/ws/a.jsonl", "A")?.sessionId).toBe("p1");
    expect(lookupParentHost("/ws/a.jsonl", "B")).toBeUndefined();
    unsub();
    expect(lookupParentHost("/ws/a.jsonl", "A")).toBeUndefined();
  });

  it("idle parent triggerTurn followUp", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "completed",
      output: "ok",
      sessionPath: "/ws/child.jsonl",
    }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-settled");
    expect(msg.display).toBe(true);
    expect(msg.details).toEqual({ childId: "sa-1", stopReason: "completed", sessionPath: "/ws/child.jsonl" });
    expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("busy parent steers without triggerTurn", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => true,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "aborted",
      output: "",
    }));
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "steer" });
  });

  it("draining writes without waking", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => true,
      sendMessage,
      prompt: vi.fn(),
    });
    sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "aborted",
      output: "",
    }));
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });
  });

  it("missing host is a no-op and reports false so the caller can fall back", () => {
    __resetParentHostsForTest();
    expect(sendSettlementToParent("/nope", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "error",
      output: "",
    }))).toBe(false);
  });

  it("reports true when a host took the notice", () => {
    __resetParentHostsForTest();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => false,
      sendMessage: vi.fn(),
      prompt: vi.fn(),
    });
    expect(sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "completed",
      output: "ok",
    }))).toBe(true);
  });
});
