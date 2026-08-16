import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { captureFingerprint, selectUncaptured } from "./capture.js";
import { createMemoryClient } from "./client.js";
import { buildRecallInjection } from "./context.js";

interface CaptureState {
  cursor: number;
  fingerprint: string;
}

const CAPTURE_STATE_TYPE = "tencentdb-memory-capture";
export const MEMORY_RECALL_PROBE_MESSAGE_TYPE = "tencentdb-memory-probe";
const MEMORY_RECALL_PROBE_PREFIX = "[tencentdb-memory-probe:";

/** Prompt used only by the migration verifier to exercise the real Pi hook. */
export function memoryRecallProbePrompt(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
    throw new Error("invalid TencentDB recall probe nonce");
  }
  return `${MEMORY_RECALL_PROBE_PREFIX}${nonce}]`;
}

function parseMemoryRecallProbeNonce(prompt: string): string | undefined {
  const match = /^\[tencentdb-memory-probe:([A-Za-z0-9_-]{1,128})\]$/.exec(prompt.trim());
  return match?.[1];
}

function restoreCaptureState(entries: unknown[]): CaptureState | undefined {
  const entry = entries
    .filter(
      (raw): raw is { type: string; customType: string; data?: CaptureState } =>
        !!raw &&
        typeof raw === "object" &&
        (raw as { type?: unknown }).type === "custom" &&
        (raw as { customType?: unknown }).customType === CAPTURE_STATE_TYPE,
    )
    .pop();
  const cursor = entry?.data?.cursor;
  const fingerprint = entry?.data?.fingerprint;
  if (!Number.isInteger(cursor) || cursor! < 0 || typeof fingerprint !== "string") return undefined;
  return { cursor: cursor!, fingerprint };
}

function initialTurnCursor(entries: unknown[]): number {
  const messageCount = entries.filter(
    (entry) => !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message",
  ).length;
  return Math.max(0, messageCount - 1);
}

export default function tencentdbMemory(pi: ExtensionAPI) {
  const turnCursors = new Map<string, number>();
  const captureStates = new Map<string, CaptureState>();
  const captureQueues = new Map<string, Promise<void>>();
  const recallProbeSessions = new Set<string>();

  pi.on("before_agent_start", async (event, ctx) => {
    const query = event.prompt.trim();
    if (!query) return undefined;
    const probeNonce = parseMemoryRecallProbeNonce(query);

    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries();
    const restored = restoreCaptureState(entries);
    if (restored) captureStates.set(sessionId, restored);
    turnCursors.set(sessionId, restored?.cursor ?? initialTurnCursor(entries));

    try {
      const injection = await buildRecallInjection(createMemoryClient(), query);
      if (probeNonce) {
        recallProbeSessions.add(sessionId);
        return {
          systemPrompt: injection.systemPrompt ? `${event.systemPrompt}\n\n${injection.systemPrompt}` : undefined,
          message: {
            customType: MEMORY_RECALL_PROBE_MESSAGE_TYPE,
            content: probeNonce,
            details: { nonce: probeNonce },
            display: false,
          },
        };
      }
      if (!injection.systemPrompt && !injection.message) return undefined;
      return {
        systemPrompt: injection.systemPrompt ? `${event.systemPrompt}\n\n${injection.systemPrompt}` : undefined,
        message: injection.message,
      };
    } catch (error) {
      if (probeNonce) recallProbeSessions.delete(sessionId);
      console.error("[tencentdb-memory] recall failed:", error);
      return undefined;
    }
  });

  // The verifier sends a normal prompt so before_agent_start really runs, then
  // aborts before any provider request can leave the machine.
  pi.on("before_provider_request", (_event, ctx) => {
    if (recallProbeSessions.has(ctx.sessionManager.getSessionId())) {
      ctx.abort();
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    if (recallProbeSessions.delete(sessionId)) return;
    const messages = [...event.messages];
    const previous = captureQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const state = captureStates.get(sessionId);
        const cursor = state?.cursor ?? turnCursors.get(sessionId) ?? 0;
        const batch = selectUncaptured(messages, cursor);
        if (batch.length === 0) return;
        const fingerprint = captureFingerprint(batch);
        // A repeated event for the same transcript is idempotent. Keep the
        // cursor in the comparison so identical content in a later turn is
        // still captured instead of being mistaken for a retry.
        if (state?.cursor === messages.length && state.fingerprint === fingerprint) return;

        const client = createMemoryClient().withIsolation({ sessionId });
        await client.addConversation({
          messages: batch.map((message, index) => ({
            ...message,
            id: `${fingerprint.slice(0, 24)}-${index}`,
          })),
        });

        const committed = { cursor: messages.length, fingerprint };
        captureStates.set(sessionId, committed);
        pi.appendEntry(CAPTURE_STATE_TYPE, committed);
      })
      .catch((error) => {
        console.error("[tencentdb-memory] capture failed:", error);
      });
    captureQueues.set(sessionId, next);
  });

  pi.registerTool({
    name: "tdai_memory_search",
    label: "TencentDB Memory Search",
    description: "Search personal long-term atomic memories across sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language memory query" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum results (default 5)" })),
    }),
    async execute(_toolCallId, params) {
      const result = await createMemoryClient().searchAtomic({ query: params.query, limit: params.limit ?? 5 });
      return {
        content: [{ type: "text", text: JSON.stringify(result.items, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "tdai_conversation_search",
    label: "TencentDB Conversation Search",
    description: "Search personal conversation memory across Pi sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language conversation query" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum results (default 5)" })),
    }),
    async execute(_toolCallId, params) {
      const result = await createMemoryClient().searchConversation({ query: params.query, limit: params.limit ?? 5 });
      return {
        content: [{ type: "text", text: JSON.stringify(result.messages, null, 2) }],
        details: result,
      };
    },
  });
}
