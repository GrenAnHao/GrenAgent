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

export default function tencentdbMemory(pi: ExtensionAPI) {
  const turnCursors = new Map<string, number>();
  const captureStates = new Map<string, CaptureState>();
  const captureQueues = new Map<string, Promise<void>>();

  pi.on("before_agent_start", async (event, ctx) => {
    const query = event.prompt.trim();
    if (!query) return undefined;

    const sessionId = ctx.sessionManager.getSessionId();
    const restored = restoreCaptureState(ctx.sessionManager.getBranch());
    if (restored) captureStates.set(sessionId, restored);
    else captureStates.delete(sessionId);
    turnCursors.set(sessionId, ctx.sessionManager.buildSessionContext().messages.length);

    try {
      const injection = await buildRecallInjection(createMemoryClient(), query);
      if (!injection.systemPrompt && !injection.message) return undefined;
      return {
        systemPrompt: injection.systemPrompt ? `${event.systemPrompt}\n\n${injection.systemPrompt}` : undefined,
        message: injection.message,
      };
    } catch (error) {
      console.error("[tencentdb-memory] recall failed:", error);
      return undefined;
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    const messages = [...event.messages];
    const cursor = turnCursors.get(sessionId) ?? captureStates.get(sessionId)?.cursor ?? 0;
    const previous = captureQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const state = captureStates.get(sessionId);
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

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    await captureQueues.get(sessionId);
    captureQueues.delete(sessionId);
    captureStates.delete(sessionId);
    turnCursors.delete(sessionId);
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
