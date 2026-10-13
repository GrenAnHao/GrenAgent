// 宿主（agent-host）与子代理 worker 进程之间的 RPC 载荷。两边都只 import type。

import type { EmbeddedSubagentOpts } from "./embedded-runner.js";

export interface WorkerSessionState {
  isStreaming: boolean;
  isIdle: boolean;
  pendingMessageCount: number;
}

/** waitForIdle / snapshot 的回复：宿主据此刷新代理会话的消息与流式状态。 */
export interface WorkerSnapshot extends WorkerSessionState {
  messages: unknown[];
  transcript: string;
  streamingDelta: string;
  structured?: unknown;
  hasStructured?: true;
}

/** PreparedEmbedded 里能过 IPC 的部分；ctx.sessionId 是函数，换成取好的值。 */
export interface SerializedPrepared {
  childConfig: Record<string, string>;
  parentPath: string | undefined;
  workspace: string;
  ctx: { origin: "subagent"; workspace: string; cwd: string; config: Record<string, string> };
  parentSessionId?: string;
}

export interface WorkerOpenRequest {
  opts: Omit<EmbeddedSubagentOpts, "signal" | "onUpdate">;
  prepared: SerializedPrepared;
}

export interface WorkerOpened {
  sessionId?: string;
  sessionPath: string;
  workspace: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  inheritedEventCount: number;
  entries: unknown[];
  state: WorkerSessionState;
}

export interface WorkerResumeRequest {
  sessionPath: string;
  ctx: { origin: "subagent"; workspace: string; cwd: string; config: Record<string, string> };
}

export interface WorkerResumed {
  sessionId?: string;
  sessionPath: string;
  cwd: string;
  model?: { provider?: string; id?: string };
  entries: unknown[];
  state: WorkerSessionState;
}
