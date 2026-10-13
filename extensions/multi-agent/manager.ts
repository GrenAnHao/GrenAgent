// 子代理管理器：所有子代理执行都从这里进，选执行后端，后端声明自己能做什么。
// 见 .agents/notes/implemented/architecture/2026-10-11-subagent-redesign.md：
// 第 1 阶段把 index.ts 里的分叉收进来；第 2 阶段统一后台交付——后台子代理一律在结束时给父会话发
// subagent-settled 通知（可续聊的由 Activation 发，其余由 startBackgroundRun 发），不再走 jobs。
// 第 3 阶段：两个后端都是真会话（worker 改为常驻 RPC 进程），只有设置 / 角色指定时才走 worker。
// 第 4 阶段：所有执行先在这里占同时活跃名额（active-runs.ts），可续聊的占到结算为止。
// 单会话名额和注册表（界面直接读 registry.db）仍在 index.ts。

import { DELEGATION_SCOPE_STATEMENT, delegationScopeWithApprovals, withDelegationScope } from "../_shared/delegation-scope.js";
import { canForwardApproval, subagentApprovalTimeoutMs } from "../_shared/approval-route.js";
import type { SubagentStopReason } from "./assistant-output.js";
import { inProcessBackend, workerBackend } from "./backends.js";
import { acquireActiveSlot } from "./active-runs.js";
import { markChildGone, markChildRunning, markChildSettled, onChildRunEvent, takeSilenced } from "./child-runs.js";
import { formatSettlementNotice, type SettlementNotice } from "./settlement-notice.js";
import { getConfig } from "../_shared/runtime-config.js";
import type { ContinuableEmbeddedOpts, ContinuableEmbeddedStart } from "./embedded-runner.js";
import type { AgentResult, AgentUpdate } from "./runner.js";

export type SubagentBackendKind = "in-process" | "worker";

/** 后端能力声明（对齐 DSH SubagentCapabilities）。调用方据此决定能不能走某条路径，不再按「跑在哪」特判。 */
export interface SubagentCapabilities {
  /** 能起可续聊子代理（Activation，结束后还能收消息）。 */
  readonly continuable: boolean;
  /** 能用父会话已完成轮次做 seed。 */
  readonly fork: boolean;
  readonly outputSchema: boolean;
  readonly toolFilter: boolean;
  readonly modelOverride: boolean;
}

/** 一次性运行的参数。 */
export interface SubagentRunOpts {
  model?: string;
  signal?: AbortSignal;
  onUpdate?: (update: AgentUpdate) => void;
  env?: Record<string, string>;
  timeoutMs?: number;
  mcp?: boolean | string[];
  /** 命名角色的系统提示（追加在子会话系统提示后面）。 */
  systemPrompt?: string;
  /** 命名角色的工具白名单。 */
  tools?: string[];
  thinkingLevel?: string;
  depth?: number;
  outputSchema?: object;
  /** 想走哪个后端（设置 / 命名角色给的）；省略按设置 SUBAGENT_BACKEND，默认进程内。 */
  backend?: SubagentBackendKind;
  parentSessionPath?: string;
  seedMessages?: unknown[];
  /** 父会话的原始目录（会话头 cwd）。进程内子会话头用它；cwd 参数是父会话的当前目录。 */
  projectCwd?: string;
}

export interface SubagentRunRequest extends SubagentRunOpts {
  cwd: string;
  task: string;
  agentId: string;
}

/**
 * 统一结果（DSH `{ output, structured?, diagnostic?, stopReason }`）。
 * 过渡期保留 AgentResult 的 ok / exitCode / error / partial / transcript，index.ts 各路径还在读。
 * 子级失败不 reject，看 stopReason。
 */
export interface SubagentResult extends AgentResult {
  backend: SubagentBackendKind;
  stopReason: SubagentStopReason;
  sessionPath?: string;
  structured?: unknown;
  /** 非 completed 时的失败说明，和 output 分开给；不超过 DIAGNOSTIC_MAX_BYTES。 */
  diagnostic?: string;
}

export interface SubagentBackend {
  readonly kind: SubagentBackendKind;
  readonly capabilities: SubagentCapabilities;
  run(request: SubagentRunRequest): Promise<SubagentResult>;
  startContinuable?(opts: ContinuableEmbeddedOpts): Promise<ContinuableEmbeddedStart>;
}

/** 解析后端偏好：显式给的（命名角色）优先，其次设置 SUBAGENT_BACKEND；都没有就进程内。不按负载自动挪。 */
export function preferredBackend(explicit?: string): SubagentBackendKind {
  const value = (explicit ?? getConfig("SUBAGENT_BACKEND") ?? "").trim().toLowerCase();
  return value === "worker" ? "worker" : "in-process";
}

/**
 * 子代理的委派声明：父会话能替它问人（approval-route.ts）就说审批会转给用户，否则说会被自动拒绝。
 * 宿主进程里同步就能定（不多等一拍）；只有 worker 里派孙代理时要问宿主。
 */
function delegatedPrompt(systemPrompt: string | undefined, parentSessionPath: string | undefined): string | Promise<string> {
  const pick = (canAsk: boolean) =>
    withDelegationScope(
      systemPrompt,
      canAsk ? delegationScopeWithApprovals(Math.round(subagentApprovalTimeoutMs() / 1000)) : DELEGATION_SCOPE_STATEMENT,
    );
  const reach = canForwardApproval(parentSessionPath?.trim() || undefined);
  return typeof reach === "boolean" ? pick(reach) : reach.then(pick);
}

export function selectSubagentBackend(preference?: string): SubagentBackend {
  return preferredBackend(preference) === "worker" ? workerBackend : inProcessBackend;
}

export async function runSubagent(
  cwd: string,
  task: string,
  agentId: string,
  opts: SubagentRunOpts,
): Promise<SubagentResult> {
  const backend = selectSubagentBackend(opts.backend);
  const release = await acquireActiveSlot({ childId: agentId, backend: backend.kind, depth: opts.depth }, opts.signal);
  try {
    const prompt = delegatedPrompt(opts.systemPrompt, opts.parentSessionPath);
    const systemPrompt = typeof prompt === "string" ? prompt : await prompt;
    return await backend.run({ ...opts, cwd, task, agentId, systemPrompt });
  } finally {
    release();
  }
}

export interface BackgroundRunOpts extends SubagentRunOpts {
  /** 直接父会话 id：wait_agent 和父 Activation 按它找子代理。 */
  parentSessionId: string;
  /** 把结算通知交给父会话（宿主或扩展 API），由调用方给。抛错只吞掉，不影响收尾。 */
  deliver: (notice: SettlementNotice) => void;
  /** 记账（注册表、名额、目录），在发通知之前调用。 */
  onSettled?: (result: SubagentResult) => void;
}

function failedResult(kind: SubagentBackendKind, error: unknown, aborted: boolean): SubagentResult {
  const message = String((error as Error)?.message ?? error);
  return {
    ok: false,
    output: "",
    exitCode: -1,
    error: message,
    transcript: "",
    backend: kind,
    stopReason: aborted ? "aborted" : "error",
    diagnostic: message,
  };
}

/**
 * 一个一次性子代理在后台结束：把 subagent-settled 通知交给父会话（delivery: parent），再登记已结算（wait_agent 随之醒来）。
 * 记账（注册表、名额、目录）由调用方在这之前做完。删除过的子代理不再通知。
 */
export function settleOneShot(
  agentId: string,
  result: Pick<SubagentResult, "stopReason" | "output" | "sessionPath" | "diagnostic">,
  opts: { parentSessionId: string; deliver: (notice: SettlementNotice) => void },
): void {
  if (takeSilenced(agentId)) {
    markChildGone(agentId);
    return;
  }
  try {
    opts.deliver(
      formatSettlementNotice({
        childId: agentId,
        stopReason: result.stopReason,
        output: result.output,
        sessionPath: result.sessionPath,
        continuable: false,
        diagnostic: result.diagnostic,
      }),
    );
  } catch {
    /* 父会话已经不在：通知丢掉，wait_agent 仍然会醒 */
  }
  markChildSettled({ childId: agentId, parentSessionId: opts.parentSessionId, stopReason: result.stopReason });
}

/**
 * 把一个已经在跑的一次性子代理交到后台：登记为在跑（wait_agent、父 Activation 都看得到），
 * 结束时先 onSettled 记账，再发结算通知。后台 spawn 和前台 run 转后台共用。
 */
export function settleInBackground(
  run: Promise<SubagentResult>,
  agentId: string,
  opts: {
    kind: SubagentBackendKind;
    parentSessionId: string;
    signal?: AbortSignal;
    deliver: (notice: SettlementNotice) => void;
    onSettled?: (result: SubagentResult) => void;
  },
): void {
  markChildRunning(agentId, opts.parentSessionId);
  void run
    .catch((e: unknown) => failedResult(opts.kind, e, opts.signal?.aborted === true))
    .then((result) => {
      try {
        opts.onSettled?.(result);
      } catch (error) {
        // 记账出错不能挡住通知。
        console.error(`[multi-agent] sub-agent ${agentId}: recording the result failed`, error);
      }
      settleOneShot(agentId, result, opts);
    })
    .catch((error: unknown) => console.error(`[multi-agent] sub-agent ${agentId}: settlement failed`, error));
}

/**
 * 后台跑一次（不能续聊的后端走这里；可续聊的走 startContinuableSubagent）。立即返回，
 * 结束后先 onSettled 记账，再把 subagent-settled 通知交给父会话（delivery: parent）。
 */
export function startBackgroundRun(
  cwd: string,
  task: string,
  agentId: string,
  opts: BackgroundRunOpts,
): void {
  const { parentSessionId, deliver, onSettled, ...runOpts } = opts;
  const kind = selectSubagentBackend(runOpts.backend).kind;
  settleInBackground(runSubagent(cwd, task, agentId, runOpts), agentId, {
    kind,
    parentSessionId,
    ...(runOpts.signal ? { signal: runOpts.signal } : {}),
    deliver,
    ...(onSettled ? { onSettled } : {}),
  });
}

/** 调用前先看 selectSubagentBackend(opts.backend).capabilities.continuable；不支持时这里直接报错。 */
export async function startContinuableSubagent(opts: ContinuableEmbeddedOpts): Promise<ContinuableEmbeddedStart> {
  const backend = selectSubagentBackend(opts.backend);
  if (!backend.capabilities.continuable || !backend.startContinuable) {
    throw new Error(`${backend.kind} 后端不支持可续聊子代理`);
  }
  const release = await acquireActiveSlot({ childId: opts.agentId, backend: backend.kind, depth: opts.depth }, opts.signal);
  // 名额占到这个子代理结算（或没结算就离开）为止。
  const off = onChildRunEvent((event) => {
    if (event.childId !== opts.agentId) return;
    off();
    release();
  });
  try {
    const prompt = delegatedPrompt(opts.systemPrompt, opts.parentSessionPath);
    const systemPrompt = typeof prompt === "string" ? prompt : await prompt;
    return await backend.startContinuable({ ...opts, systemPrompt });
  } catch (error) {
    off();
    release();
    throw error;
  }
}
