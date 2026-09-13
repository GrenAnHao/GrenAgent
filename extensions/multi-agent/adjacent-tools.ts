import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  authorizeParent,
  coldResumeAndDeliver,
  deliverToChild,
  getActivation,
  interruptChild,
} from "./activation.js";
import { getRegistry } from "./controlPlane.js";
import { SubagentError, type Delivery } from "./inbox.js";
import { lookupParentHost } from "./parent-host.js";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: Record<string, unknown>;
};

function lastSubagentMeta(entries: unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i] as SessionEntry;
    if (item?.type === "custom" && item.customType === "subagent_meta" && item.data && typeof item.data === "object") {
      found = item.data;
    }
  }
  return found;
}

/** Peek JSONL last subagent_meta.parentSessionId. Unreadable / no meta → undefined. */
function peekParentSessionId(sessionPath: string): { readable: boolean; parentSessionId?: string } {
  try {
    const entries = SessionManager.open(sessionPath).getEntries();
    const meta = lastSubagentMeta(entries);
    if (!meta) return { readable: false };
    const parent = meta.parentSessionId;
    return {
      readable: true,
      parentSessionId: typeof parent === "string" && parent.trim() ? parent.trim() : undefined,
    };
  } catch {
    return { readable: false };
  }
}

export function continuableReturnGuidance(parentSessionId: string): string {
  const id = JSON.stringify(parentSessionId);
  return (
    `Your parent agent id is ${id}. Before you finish, send your result to that agent with send_message({ agent_id: ${id}, message: "<self-contained result>" }). ` +
    "The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. " +
    "Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn."
  );
}

function composeDelivery(senderId: string, message: string): string {
  return `Agent ${senderId} sent a message: ${message}`;
}

function lastUserMessageId(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  let found: string | undefined;
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i] as { role?: unknown; id?: unknown } | null | undefined;
    if (item && item.role === "user" && typeof item.id === "string" && item.id) {
      found = item.id;
    }
  }
  return found;
}

function delivered(agentId: string, messageId?: string) {
  return {
    content: [{ type: "text" as const, text: `message delivered to agent ${agentId}` }],
    details: messageId ? { messageId } : {},
  };
}

function fail(error: unknown) {
  if (error instanceof SubagentError) {
    return {
      content: [{ type: "text" as const, text: `未送达 (${error.code}): ${error.message}` }],
      details: { code: error.code },
      isError: true as const,
    };
  }
  const message = String((error as Error)?.message ?? error);
  return {
    content: [{ type: "text" as const, text: `未送达: ${message}` }],
    details: {},
    isError: true as const,
  };
}

function senderIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (id && id.trim()) return id.trim();
  } catch {
    /* sessionManager 不可用 */
  }
  throw new SubagentError("session id is unavailable", "PARENT_UNAVAILABLE");
}

function registrySessionPath(cwd: string, agentId: string): string | undefined {
  const path = getRegistry(cwd).get(agentId)?.sessionPath;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

async function executeSendMessage(
  params: { agent_id?: string; message?: string },
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } },
) {
  try {
    const senderId = senderIdOf(ctx);
    const agentId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
    const message = typeof params.message === "string" ? params.message : "";
    if (!agentId) {
      throw new SubagentError("agent_id is required", "UNAUTHORIZED");
    }
    const text = composeDelivery(senderId, message);

    if (senderId === agentId) {
      throw new SubagentError("cannot send_message to self", "UNAUTHORIZED");
    }

    const targetAct = getActivation(agentId);
    const senderAct = getActivation(senderId);

    if (targetAct && targetAct.parentSessionId === senderId) {
      authorizeParent(targetAct, ctx.cwd);
      const delivery: Delivery = targetAct.session.isStreaming ? "steer" : "followUp";
      deliverToChild(agentId, text, delivery);
      return delivered(agentId, lastUserMessageId(targetAct.session.messages));
    }

    if (senderAct && senderAct.parentSessionId === agentId) {
      authorizeParent(senderAct, ctx.cwd);
      const host = lookupParentHost(senderAct.parentSessionPath, ctx.cwd);
      if (!host) {
        throw new SubagentError("parent host is not available in this process", "PARENT_UNAVAILABLE");
      }
      host.prompt(text, host.isBusy() ? "steer" : "followUp");
      return delivered(agentId);
    }

    if (targetAct || senderAct) {
      throw new SubagentError("sender is not the direct parent or child of the target", "UNAUTHORIZED");
    }

    const sessionPath = registrySessionPath(ctx.cwd, agentId);
    if (sessionPath) {
      const peek = peekParentSessionId(sessionPath);
      if (!peek.readable) {
        throw new SubagentError(`child ${agentId} is not resumable`, "NOT_RESUMABLE");
      }
      if (peek.parentSessionId !== senderId) {
        throw new SubagentError("sender is not the direct parent of the target", "UNAUTHORIZED");
      }
      await coldResumeAndDeliver(agentId, sessionPath, text, "followUp");
      const resumed = getActivation(agentId);
      return delivered(agentId, lastUserMessageId(resumed?.session.messages));
    }

    const senderPath = registrySessionPath(ctx.cwd, senderId);
    if (senderPath) {
      const peek = peekParentSessionId(senderPath);
      if (peek.readable && peek.parentSessionId === agentId) {
        throw new SubagentError("parent host is not available in this process", "PARENT_UNAVAILABLE");
      }
    }

    throw new SubagentError("sender is not the direct parent or child of the target", "UNAUTHORIZED");
  } catch (error) {
    return fail(error);
  }
}

function executeInterrupt(
  params: { agent_id?: string },
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } },
) {
  try {
    const senderId = senderIdOf(ctx);
    const agentId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
    if (!agentId) {
      throw new SubagentError("agent_id is required", "UNAUTHORIZED");
    }
    if (senderId === agentId) {
      throw new SubagentError("cannot interrupt self", "UNAUTHORIZED");
    }
    const targetAct = getActivation(agentId);
    if (!targetAct) {
      return {
        content: [{ type: "text" as const, text: `interrupt requested for agent ${agentId}` }],
        details: { agentId },
      };
    }
    if (targetAct.parentSessionId !== senderId) {
      throw new SubagentError("only the direct parent may interrupt a resident child", "UNAUTHORIZED");
    }
    authorizeParent(targetAct, ctx.cwd);
    interruptChild(agentId);
    return {
      content: [{ type: "text" as const, text: `interrupt requested for agent ${agentId}` }],
      details: { agentId },
    };
  } catch (error) {
    return fail(error);
  }
}

export function registerAdjacentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to an adjacent agent: the direct parent or a direct child. " +
      "Siblings, skip-generation relatives, and self are rejected. " +
      "Only parent-to-child may cold-resume a continuable JSONL session.",
    promptGuidelines: [
      "Use send_message to talk to your direct parent or a child you spawned.",
      "The recipient does not automatically see your transcript or tool output — include a self-contained message.",
      "Sending a message does not end your turn.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target agent id (direct parent or direct child)." }),
      message: Type.String({ description: "Self-contained message body to deliver." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSendMessage(params, ctx);
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description:
      "Interrupt a resident child agent. Only the direct parent may interrupt. " +
      "If the target is not resident, the request is recorded without error.",
    promptGuidelines: [
      "Use interrupt_agent to stop a resident child you spawned.",
      "Interrupting yourself, a sibling, or a non-child is rejected.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Resident child agent id to interrupt." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeInterrupt(params, ctx);
    },
  });
}
