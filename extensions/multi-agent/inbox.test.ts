import { describe, expect, it, vi } from "vitest";
import { SubagentError, SubagentInbox } from "./inbox.js";

function fakeSession(over: Partial<{
  isStreaming: boolean;
  pendingMessageCount: number;
  prompt: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isStreaming: over.isStreaming ?? false,
    pendingMessageCount: over.pendingMessageCount ?? 0,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: over.prompt ?? vi.fn(async () => {}),
  };
}

describe("SubagentInbox", () => {
  it("rejects deliver after close", () => {
    const session = fakeSession();
    const inbox = new SubagentInbox(session as never);
    void inbox.close(async () => {});
    try {
      inbox.deliver("hi", "followUp");
      expect.unreachable("deliver should throw after close");
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentError);
      expect((error as SubagentError).code).toBe("ACTIVATION_CLOSING");
      expect((error as SubagentError).message).toBe("activation is being disposed; the message was not accepted");
    }
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("hasPending follows pendingMessageCount", () => {
    const session = fakeSession({ pendingMessageCount: 2 });
    const inbox = new SubagentInbox(session as never);
    expect(inbox.hasPending).toBe(true);
    session.pendingMessageCount = 0;
    expect(inbox.hasPending).toBe(false);
  });

  it("steers when asked and session is streaming", async () => {
    const prompt = vi.fn(async () => {});
    const session = fakeSession({ isStreaming: true, prompt });
    const inbox = new SubagentInbox(session as never);
    inbox.deliver("go", "steer");
    expect(prompt).toHaveBeenCalledWith("go", { streamingBehavior: "steer" });
  });

  it("followUp omits streamingBehavior when idle", () => {
    const prompt = vi.fn(async () => {});
    const session = fakeSession({ isStreaming: false, prompt });
    const inbox = new SubagentInbox(session as never);
    inbox.deliver("next", "followUp");
    expect(prompt).toHaveBeenCalledWith("next", {});
  });
});
