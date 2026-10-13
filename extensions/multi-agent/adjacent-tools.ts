import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { projectCwd } from "../_shared/session-cwd.js";
import {
  agentMessage,
  authorizeParent,
  coldResumeAndDeliver,
  deliverToChild,
  deliverWithoutWaking,
  activationHasLiveWork,
  getActivation,
  interruptChild,
  type Activation,
} from "./activation.js";
import { getRegistry } from "./controlPlane.js";
import { SubagentError, type Delivery } from "./inbox.js";
import { lookupParentHost } from "./parent-host.js";

function callerWorkspace(ctx: { cwd: string }): string {
  return currentWorkspaceContext()?.workspace ?? ctx.cwd;
}

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
  // 最终结果用 wake: false：子代理随后就结算，结算通知会唤醒父会话；这里再唤醒一次，父会话会为同一个结果跑两轮。
  return (
    `Your parent agent id is ${id}. Before you finish, send your result to that agent with send_message({ agent_id: ${id}, message: "<self-contained result>", wake: false }); ` +
    "you settle right after and the settlement notice wakes the parent, so waking it for the final result would make it run twice " +
    "(if you still have child agents or background jobs running, the message wakes the parent anyway). " +
    "The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. " +
    "Send earlier messages with the default wake when a finding changes what the parent should do next; sending a message does not end your turn."
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

/** wake: false 的回执：对方在跑就是排到它下一步之前；空闲的只追加，不开轮。 */
function deliveredQuietly(agentId: string, how: "next-step" | "appended") {
  const text =
    how === "next-step"
      ? `message delivered to agent ${agentId}; it is running and will see it at its next step`
      : `message delivered to agent ${agentId} without waking it; it will see the message the next time it runs`;
  return { content: [{ type: "text" as const, text }], details: { woken: false, delivery: how } };
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
  params: { agent_id?: string; message?: string; wake?: boolean },
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } },
) {
  try {
    const senderId = senderIdOf(ctx);
    const agentId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
    const message = typeof params.message === "string" ? params.message : "";
    // 默认唤醒；只有明确传 false 才不唤醒。
    const wake = params.wake !== false;
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
      authorizeParent(targetAct, callerWorkspace(ctx));
      if (!wake) {
        // 带上会话路径：这一刻它可能刚好结算并离开内存，锁里查不到会话时按已卸载追加，而不是误报不能续聊。
        const how = await deliverWithoutWaking(agentId, {
          sessionPath: targetAct.sessionPath,
          message: agentMessage(senderId, message),
        });
        return deliveredQuietly(agentId, how);
      }
      const delivery: Delivery = targetAct.session.isStreaming ? "steer" : "followUp";
      deliverToChild(agentId, text, delivery);
      return delivered(agentId, lastUserMessageId(targetAct.session.messages));
    }

    if (!targetAct) {
      const sessionPath = registrySessionPath(projectCwd(ctx), agentId);
      if (sessionPath) {
        const peek = peekParentSessionId(sessionPath);
        if (peek.readable && peek.parentSessionId === senderId) {
          if (!wake) {
            // 驻留池里的追加进会话；已卸载的直接追加到 JSONL，不加载会话。
            const how = await deliverWithoutWaking(agentId, { sessionPath, message: agentMessage(senderId, message) });
            return deliveredQuietly(agentId, how);
          }
          if (senderAct) {
            await coldResumeAndDeliver(agentId, sessionPath, text, "followUp", {
              senderActivationId: senderId,
            });
          } else {
            await coldResumeAndDeliver(agentId, sessionPath, text, "followUp");
          }
          const resumed = getActivation(agentId);
          return delivered(agentId, lastUserMessageId(resumed?.session.messages));
        }
        if (!peek.readable && !senderAct) {
          throw new SubagentError(`child ${agentId} is not resumable`, "NOT_RESUMABLE");
        }
        if (peek.readable && peek.parentSessionId !== senderId && !senderAct) {
          throw new SubagentError("sender is not the direct parent of the target", "UNAUTHORIZED");
        }
      }
    }

    if (senderAct && senderAct.parentSessionId === agentId) {
      authorizeParent(senderAct, callerWorkspace(ctx));
      const host = lookupParentHost(senderAct.parentSessionPath, senderAct.workspace);
      if (!host) {
        throw new SubagentError("parent host is not available in this process", "PARENT_UNAVAILABLE");
      }
      // 自己还有没结束的活（子代理、后台任务）时，这一轮结束后不会马上结算，父会话不会被结算通知叫醒：
      // 交最终结果时不唤醒，父会话可能一直睡着。这种情况照常唤醒，并在回执里说明。
      const stillWorking = !wake && activationHasLiveWork(senderId);
      if (!wake && !stillWorking) {
        // 父会话在跑还是空闲由持有它的那一侧当场判断：在跑就排到它下一步之前，空闲就只追加、不开轮。
        const how = host.isBusy() ? "next-step" : "appended";
        host.sendMessage(agentMessage(senderId, message), { triggerTurn: false });
        return deliveredQuietly(agentId, how);
      }
      host.prompt(text, host.isBusy() ? "steer" : "followUp");
      if (stillWorking) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `message delivered to agent ${agentId} and woke it: you still have child agents or background jobs running, ` +
                "so you will not settle right away and no settlement notice would wake it",
            },
          ],
          details: { woken: true, reason: "sender-has-live-work" },
        };
      }
      return delivered(agentId);
    }

    if (targetAct || senderAct) {
      throw new SubagentError("sender is not the direct parent or child of the target", "UNAUTHORIZED");
    }

    const senderPath = registrySessionPath(projectCwd(ctx), senderId);
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

function isAncestor(senderId: string, target: Activation): boolean {
  let cur: Activation | undefined = target;
  while (cur) {
    if (cur.parentSessionId === senderId) return true;
    cur = cur.parentActivationId ? getActivation(cur.parentActivationId) : undefined;
  }
  return false;
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
    if (!isAncestor(senderId, targetAct)) {
      throw new SubagentError("only an ancestor may interrupt a resident agent", "UNAUTHORIZED");
    }
    authorizeParent(targetAct, callerWorkspace(ctx));
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
      "Only parent-to-child may cold-resume a continuable JSONL session. " +
      "By default an idle recipient starts a turn to handle the message (wake: true). " +
      "With wake: false the recipient is never woken: a running recipient still sees it at its next step, " +
      "an idle or unloaded one finds it in its context the next time it runs.",
    promptSnippet: "Send a message to a parent or child agent.",
    promptGuidelines: [
      "Use send_message to talk to your direct parent or a child you spawned.",
      "The recipient does not automatically see your transcript or tool output — include a self-contained message.",
      "Sending a message does not end your turn.",
      "Use send_message with wake: false for information the recipient does not need to act on right away; it reads it the next time it runs.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target agent id (direct parent or direct child)." }),
      message: Type.String({ description: "Self-contained message body to deliver." }),
      wake: Type.Optional(
        Type.Boolean({
          description:
            "Default true: an idle recipient starts a turn for this message. false: deliver without starting a turn " +
            "(a running recipient still sees it at its next step).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSendMessage(params, ctx);
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description:
      "Interrupt a resident agent's current turn. The target may be your direct child or any deeper agent created under you. " +
      "Only the current turn stops; queued messages stay parked and agents it started keep running. " +
      "If the target is not resident, the request is recorded without error.",
    promptSnippet: "Interrupt a resident descendant agent.",
    promptGuidelines: [
      "Use interrupt_agent to stop a resident descendant you (directly or indirectly) spawned.",
      "Interrupting yourself, a sibling, or a non-descendant is rejected.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Resident descendant agent id to interrupt." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeInterrupt(params, ctx);
    },
  });
}
