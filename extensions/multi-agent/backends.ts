// 子代理执行后端。两个后端跑的是同一套 runner（embedded-runner.ts：超时看门狗、Activation、结算），
// 区别只在子会话建在哪：
//   in-process：agent-host 进程里（openEmbeddedChildSession）；
//   worker：独立 worker 进程里，经 RPC 驱动（worker-session.ts，阶段 3 起常驻、能续聊、能 fork）。

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentStopReason } from "./assistant-output.js";
import {
  openEmbeddedChildSession,
  runEmbeddedSubagent,
  startContinuableEmbedded,
  type ChildSessionOpener,
} from "./embedded-runner.js";
import type { SubagentBackend, SubagentBackendKind, SubagentCapabilities, SubagentResult } from "./manager.js";
import { openWorkerChildSession } from "./worker-session.js";

/** DSH 对 diagnostic 的上限：4096 个 UTF-8 字节。 */
export const DIAGNOSTIC_MAX_BYTES = 4096;

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}

function diagnosticOf(stopReason: SubagentStopReason, error: string | undefined): { diagnostic?: string } {
  if (stopReason === "completed" || !error?.trim()) return {};
  return { diagnostic: truncateUtf8(error, DIAGNOSTIC_MAX_BYTES) };
}

/** 两个后端都是真会话，能力一样。 */
const SESSION_CAPABILITIES: SubagentCapabilities = Object.freeze({
  continuable: true,
  fork: true,
  outputSchema: true,
  toolFilter: true,
  modelOverride: true,
});

function sessionBackend(kind: SubagentBackendKind, open: ChildSessionOpener): SubagentBackend {
  return {
    kind,
    capabilities: SESSION_CAPABILITIES,
    async run(req): Promise<SubagentResult> {
      const r = await runEmbeddedSubagent(
        {
          cwd: req.cwd,
          ...(req.projectCwd ? { projectCwd: req.projectCwd } : {}),
          task: req.task,
          agentId: req.agentId,
          parentSessionPath: req.parentSessionPath,
          model: req.model,
          systemPrompt: req.systemPrompt,
          tools: req.tools,
          env: req.env,
          mcp: req.mcp,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          onUpdate: req.onUpdate,
          seedMessages: req.seedMessages,
          thinkingLevel: req.thinkingLevel as ThinkingLevel | undefined,
          depth: req.depth,
          outputSchema: req.outputSchema,
        },
        open,
      );
      return { ...r, backend: kind, ...diagnosticOf(r.stopReason, r.error) };
    },
    startContinuable: (opts) => startContinuableEmbedded(opts, open),
  };
}

export const inProcessBackend: SubagentBackend = sessionBackend("in-process", openEmbeddedChildSession);
export const workerBackend: SubagentBackend = sessionBackend("worker", openWorkerChildSession);
