import {join} from "node:path";
import {guardModelInputLimits} from "../../cli/src/model-input-limits.js";
import { attachModelCompactionControl } from '../../cli/src/model-compaction-control.js';
import {observeModelRuntime} from '../../cli/src/observed-model-runtime.js';
import {attachUsageEntryTracking} from '../usage-ledger/liveUsage.js';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { extractAssistantOutput, type SubagentStopReason } from "./assistant-output.js";
import {
  SubagentError,
  SubagentInbox,
  type Delivery,
  type InboxSession,
} from "./inbox.js";
import { jobs } from "../jobs/service.js";
import type { JobSnapshot } from "../jobs/types.js";
import type { BackgroundBashTimeout, SubagentBashState } from "./background-bash.js";
import type { SubAgentRegistry } from "./registry.js";
import { installToolRefreshBatching } from "../_shared/tool-refresh-batch.js";
import { getConfig } from "../_shared/runtime-config.js";
import { attachSessionCwd } from "../_shared/session-cwd.js";
import { registerChildApprovalRoute } from "../_shared/approval-route.js";
import { sharedModelRuntime } from "../_shared/shared-model-runtime.js";
import { registerParentSessionHost, sendSettlementToParent } from "./parent-host.js";
import {
  bindRoutingDomain,
  routingModeFromMeta,
  routingWorkspaceContext,
  type RoutingMode,
} from "../_shared/ultra-context.js";
import { runInWorkspace, type WorkspaceContext } from "../_shared/workspace-context.js";
import { __resetLeakOwnerForTest, leakedErrorText, onLeakedError, runAsChild } from "../_shared/leak-owner.js";
import { abortQuietly, errorText, Teardown } from "./teardown.js";
import { formatSettlementNotice, type SettlementNotice } from "./settlement-notice.js";
import { isResumableMeta, lastSubagentMeta } from "./subagent-meta.js";
import { effectiveProjectRoot, transferredLeafToRestore } from "../_shared/session-project-transfer.js";
import {
  __resetChildRunsForTest,
  hasRunningChildren,
  markChildGone,
  markChildRunning,
  markChildSettled,
  onChildRunEvent,
} from "./child-runs.js";

export interface AgentSessionLike extends InboxSession {
  messages: unknown[];
  abort: () => Promise<unknown> | unknown;
  dispose: () => void;
  waitForIdle: () => Promise<void>;
  subscribe?: (listener: (event: AgentSessionEvent) => void) => () => void;
  sendCustomMessage?: (
    msg: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    opts: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" },
  ) => void | Promise<void>;
  /** 进程内会话有（SDK AgentSession.clearQueue）；worker 代理没有，worker 结算即退出，排着的消息随进程没了。 */
  clearQueue?: () => { steering: unknown[]; followUp: unknown[] };
}

export interface Activation {
  childId: string;
  sessionPath: string;
  parentSessionId: string;
  parentSessionPath: string;
  workspace: string;
  mode: "continuable";
  session: AgentSessionLike;
  /** In-process continuable child: its Bash runner can attest process-tree exit. */
  tracksBashExit: boolean;
  inbox: SubagentInbox;
  announced: boolean;
  ownedChildren: Set<string>;
  depth: number;
  parentActivationId?: string;
  /** 这个子会话固定的路由域（启动时定，驻留续聊 / send_message 投递都按它跑）。 */
  routingMode: RoutingMode;
  sessionManager?: {
    appendCustomEntry: (type: string, data: unknown) => void;
    getEntries: () => unknown[];
  };
}

export type ActivationSettledInfo = {
  childId: string;
  stopReason: SubagentStopReason;
  output: string;
  sessionPath: string;
  /** 按 error 结算时的原因（漏网错误、消息没送到、结算监视出错）。 */
  diagnostic?: string;
  bashTimeout?: BackgroundBashTimeout;
};

type BashTimeout = { job: JobSnapshot; confirmed?: boolean };
type ResumeLink = { senderActivationId?: string; registry?: SubAgentRegistry };

type ActivationRecord = Activation & {
  poked: boolean;
  watching: boolean;
  mustWaitForBusy: boolean;
  skipSettle: boolean;
  unregisterHost?: () => void;
  /** 审批路由（approval-route.ts）：和父会话宿主登记同进同出。 */
  unregisterApproval?: () => void;
  wakers: Array<() => void>;
  onSettled?: (info: ActivationSettledInfo) => void;
  onBashPhase?: (state: SubagentBashState | null, reply?: string) => void;
  deliverFallback?: (notice: SettlementNotice) => void;
  /** 结算后会话留着（驻留池），续聊时不必冷恢复。只给进程内会话开，worker 结算即退出。 */
  keepResident: boolean;
  /** 这一次激活里出过漏网错误或消息没送到：结算时按 error，诊断写这一句（leak-owner.ts）。 */
  failure?: string;
  offLeak?: () => void;
  offRound?: () => void;
  round?: { finalReply: boolean; completed: boolean };
  waitingForBashSince?: number;
  bashTimeouts?: Map<string, BashTimeout>;
};

// ---- 驻留：结算后的进程内子会话先不销毁，最多 SUBAGENT_MAX_RESIDENT 个（默认 8），超出按最久未用销毁（重新设计第 6 节）。
// 续聊（send_message → coldResumeAndDeliver）先找这里，找不到再按 JSONL 冷恢复。

export const DEFAULT_MAX_RESIDENT = 8;

interface ResidentSession {
  childId: string;
  sessionPath: string;
  parentSessionId: string;
  parentSessionPath: string;
  workspace: string;
  depth: number;
  routingMode: RoutingMode;
  session: AgentSessionLike;
  sessionManager?: Activation["sessionManager"];
  lastUsed: number;
}

const residents = new Map<string, ResidentSession>();

function maxResident(): number {
  // 没设时取默认值；Number("") 是 0，会把驻留误关掉。
  const raw = getConfig("SUBAGENT_MAX_RESIDENT")?.trim();
  if (!raw) return DEFAULT_MAX_RESIDENT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_RESIDENT;
}

function disposeQuietly(session: AgentSessionLike): void {
  try {
    session.dispose();
  } catch {
    /* 已经关了 */
  }
}

/** 结算时停到驻留池；超出上限按最久未用销毁。返回 false 表示不驻留（调用方自己销毁）。 */
function parkResident(act: ActivationRecord): boolean {
  if (!act.keepResident || maxResident() === 0) return false;
  residents.set(act.childId, {
    childId: act.childId,
    sessionPath: act.sessionPath,
    parentSessionId: act.parentSessionId,
    parentSessionPath: act.parentSessionPath,
    workspace: act.workspace,
    depth: act.depth,
    routingMode: act.routingMode,
    session: act.session,
    sessionManager: act.sessionManager,
    lastUsed: Date.now(),
  });
  while (residents.size > maxResident()) {
    let oldest: ResidentSession | undefined;
    for (const r of residents.values()) if (!oldest || r.lastUsed < oldest.lastUsed) oldest = r;
    if (!oldest) break;
    disposeResident(oldest.childId);
  }
  return true;
}

export function disposeResident(childId: string): void {
  const r = residents.get(childId);
  if (!r) return;
  residents.delete(childId);
  disposeQuietly(r.session);
}

// ---- retiring（迁移 drain 的隔离区） ----
//
// 迁移 drain 先从驻留池摘下会话，但如果 dispose 确认失败（worker 超时 / 报错），旧写者可能仍在写
// 同一份 JSONL。此时**不能**把「不在驻留池」当成「已经停」：下一次 preview / drain 会误判空闲。
// retiring 表保留这些未证明收口的会话，直到 dispose ack 或进程退出可证明关闭才清；
// `residentChildIds` / 活动检查 / drain 都会看见它们（fail-closed）。

interface RetiringResident {
  childId: string;
  sessionPath: string;
  session: AgentSessionLike;
  /** 进行中 / 已完成的收口确认；true 之后才允许从 retiring 清掉。 */
  ack: Promise<boolean>;
  /** ack 的最终结果（迟到回执也会在这里落下）。 */
  confirmed?: boolean;
  diagnostic?: string;
}

const retiring = new Map<string, RetiringResident>();

function watchRetiring(entry: RetiringResident): void {
  void entry.ack.then(
    (confirmed) => {
      entry.confirmed = confirmed;
    },
    () => {
      entry.confirmed = false;
    },
  );
}

function retiringConfirmed(entry: RetiringResident): boolean {
  // worker 代理的只读事实（ack 或进程退出）优先；否则看 ack 结果是否已经落下。
  const session = entry.session as AgentSessionLike & { disposalConfirmed?: boolean };
  if (typeof session.disposalConfirmed === "boolean" && session.disposalConfirmed) return true;
  return entry.confirmed === true;
}

/** 该 id 是否在迁移隔离区（旧写者尚未证明停止）。 */
export function isResidentRetiring(childId: string): boolean {
  return retiring.has(childId);
}

export function retiringResidentIds(): string[] {
  return [...retiring.keys()];
}

/** 已经被确认、可以安全移出隔离区的 id（清表用；不影响调用方的 busy 判断顺序）。 */
function settleRetiring(): void {
  for (const [id, entry] of [...retiring]) {
    if (retiringConfirmed(entry)) retiring.delete(id);
  }
}

/** 测试 / 诊断：隔离区里的会话是否仍有未完成的写者（true 表示不能迁移）。 */
export function hasUnsettledRetiringResident(childId: string): boolean {
  settleRetiring();
  return retiring.has(childId);
}

export interface ResidentDisposeResult {
  /** true 表示已证明这个子会话不再写 JSONL（进程内 dispose 完成 / worker 回执或退出）。 */
  confirmed: boolean;
  /** confirmed=false 时的诊断（超时、worker 报错等）。 */
  diagnostic?: string;
  /** 仍在隔离区、下一次迁移仍会拒绝的 id。 */
  retiring?: boolean;
}

/**
 * 迁移 drain 专用：把驻留子会话收口，并**等它真的不再写会话**。
 *
 * 与 `disposeResident` 的差别：
 * - 等待：进程内会话的 dispose 同步关闭文件句柄；worker 后端是代理对象（`dispose()` 只发 RPC），
 *   迁移随后要改同一份 JSONL，必须等 `disposeAndWait` 的确认；
 * - 隔离：确认失败时把会话留在 retiring 表（不从「不知道」直接变成「空闲」），
 *   后续 preview / drain / 活动检查都会继续判忙，直到迟到的 ack / 进程退出。
 *
 * 不写 `subagent_meta.tornDown`、不发结算通知、不改终态，也不会碰其他 resident。
 */
export async function disposeResidentForTransfer(
  childId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ResidentDisposeResult> {
  // 已在隔离区：只有确认事实成立才放行；否则继续拒绝（第二次 drain 不能因为「找不到 resident」就默认成功）。
  const quarantined = retiring.get(childId);
  if (quarantined) {
    settleRetiring();
    if (!retiring.has(childId)) return { confirmed: true };
    // 进程内会话没有异步回执：可以再试一次同步 dispose，成功即证明句柄已关。
    if (typeof (quarantined.session as { disposeAndWait?: unknown }).disposeAndWait !== "function") {
      try {
        quarantined.session.dispose();
        retiring.delete(childId);
        return { confirmed: true };
      } catch (error) {
        quarantined.diagnostic = `in-process dispose failed: ${errorText(error)}`;
      }
    }
    return {
      confirmed: false,
      diagnostic: quarantined.diagnostic ?? "previous dispose is still unconfirmed",
      retiring: true,
    };
  }

  const resident = residents.get(childId);
  if (!resident) return { confirmed: true };
  // 先从驻留池摘掉：即使随后确认失败，也不会有人再复用这个旧会话去写。
  residents.delete(childId);
  const session = resident.session as AgentSessionLike & {
    disposeAndWait?: (timeoutMs?: number) => Promise<{ confirmed: boolean }>;
    disposalConfirmed?: boolean;
  };

  if (typeof session.disposeAndWait === "function") {
    let ack: Promise<boolean>;
    try {
      ack = Promise.resolve(session.disposeAndWait(opts.timeoutMs)).then(
        (result) => result?.confirmed === true,
        () => false,
      );
    } catch (error) {
      ack = Promise.resolve(false);
      retiring.set(childId, {
        childId,
        sessionPath: resident.sessionPath,
        session,
        ack,
        confirmed: false,
        diagnostic: `worker dispose threw: ${errorText(error)}`,
      });
      return { confirmed: false, diagnostic: `worker dispose threw: ${errorText(error)}`, retiring: true };
    }
    const entry: RetiringResident = { childId, sessionPath: resident.sessionPath, session, ack };
    watchRetiring(entry);
    // 先登记再 await：即使这里超时返回 false，迟到的 ack 仍能把隔离区收敛掉。
    retiring.set(childId, entry);
    const confirmed = await ack;
    if (confirmed) {
      retiring.delete(childId);
      return { confirmed: true };
    }
    entry.diagnostic = "worker did not acknowledge dispose before timeout";
    return { confirmed: false, diagnostic: entry.diagnostic, retiring: true };
  }

  // 进程内会话：dispose 同步关句柄，但抛错同样不能假装成功。
  try {
    session.dispose();
    return { confirmed: true };
  } catch (error) {
    const diagnostic = `in-process dispose failed: ${errorText(error)}`;
    retiring.set(childId, {
      childId,
      sessionPath: resident.sessionPath,
      session,
      ack: Promise.resolve(false),
      confirmed: false,
      diagnostic,
    });
    return { confirmed: false, diagnostic, retiring: true };
  }
}

/**
 * 驻留会话此刻看起来是否已结算空闲（迁移 drain 前的最后一道检查）。
 * 已登记但尚未证明收口的旧写者（隔离区）返回 false，不让它被当成 idle。
 */
export function residentIsIdle(childId: string): boolean | undefined {
  if (hasUnsettledRetiringResident(childId)) return false;
  const resident = residents.get(childId);
  if (!resident) return undefined;
  const session = resident.session as AgentSessionLike & { isIdle?: unknown };
  if (typeof session.isIdle === "boolean") return session.isIdle && session.isStreaming !== true;
  return session.isStreaming !== true;
}

/** 父会话要换走 / 关掉，或整个工作区要释放：把它们的驻留会话销毁。 */
export function disposeResidentsWhere(match: (r: { parentSessionPath: string; workspace: string }) => boolean): void {
  for (const r of [...residents.values()]) if (match(r)) disposeResident(r.childId);
}

/**
 * 驻留池里的 id + 迁移隔离区里尚未证明停止的 id。
 * 隔离中的会话已经不可被续聊复用，但对「能不能安全迁移」仍是活写者，必须被看见。
 */
export function residentChildIds(): string[] {
  settleRetiring();
  return [...new Set([...residents.keys(), ...retiring.keys()])];
}

type IdleAwareSession = AgentSessionLike & { isIdle?: unknown };

export class ChildLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(childId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(childId) ?? Promise.resolve();
    const settled = prev.then(
      () => undefined,
      () => undefined,
    );
    const result = settled.then(op);
    this.tails.set(
      childId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

const activations = new Map<string, ActivationRecord>();
const childLock = new ChildLock();
let watchEpoch = 0;

const noopUi: ExtensionUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  editor: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: (async () => undefined) as ExtensionUIContext["custom"],
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  theme: {} as ExtensionUIContext["theme"],
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "unsupported" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

/** 激活的域上下文：键集照旧（继承面不变），只把域键换成这个子会话自己固定的那一份。 */
function domainOf(
  workspace: string,
  cwd: string,
  mode: RoutingMode,
  config: Readonly<Record<string, string>> | undefined = undefined,
): WorkspaceContext {
  return routingWorkspaceContext(mode, { workspace, cwd, ...(config ? { config } : {}) });
}

function domainCwd(sessionManager: Activation["sessionManager"] | undefined): string {
  return sessionCwd(sessionManager);
}

/** 投递面（prompt / sendCustomMessage）在这个子会话自己的域里执行。 */
function inDomain<T>(domain: WorkspaceContext, fn: () => T): T {
  return runInWorkspace(domain, fn);
}

function isSessionIdle(session: AgentSessionLike): boolean {
  const idle = (session as IdleAwareSession).isIdle;
  if (typeof idle === "boolean") return idle;
  return !session.isStreaming;
}

function poke(act: ActivationRecord): void {
  act.poked = true;
  if (isSessionIdle(act.session)) act.mustWaitForBusy = true;
  wake(act);
}

function wake(act: ActivationRecord): void {
  for (const w of act.wakers.splice(0)) w();
}

/**
 * 这一次激活出了漏网错误，或者给它的消息没送到：记下失败，正在跑就中断这一轮，结算时按 error。
 * 照 DSH 不销毁：结算后照常进驻留池，之后还能续聊；下一次激活重新算。
 */
function failActivation(act: ActivationRecord, reason: string): void {
  if (activations.get(act.childId) !== act) return;
  act.failure ??= reason;
  abortIfFailed(act);
  wake(act);
}

function isBusy(act: ActivationRecord): boolean {
  return !isSessionIdle(act.session) || act.session.isStreaming === true;
}

/**
 * 出过错、会话又在跑：中断。错误到的时候会话可能还在 preflight（看着空闲），那时的中断会被起跑重置，
 * 所以会话真跑起来时（监视等到忙、开始监视）再中断一次。
 */
function abortIfFailed(act: ActivationRecord): void {
  if (act.failure && isBusy(act)) abortQuietly(act.session);
}

/** 出过错的激活要结算了：排着的消息不会再被处理（SDK 的 abort 不清队列），清掉，在诊断里写明。 */
function failureDiagnostic(act: ActivationRecord, reason: string): string {
  let dropped = 0;
  try {
    const cleared = act.session.clearQueue?.();
    dropped = (cleared?.steering.length ?? 0) + (cleared?.followUp.length ?? 0);
  } catch {
    /* 清不掉就不写 */
  }
  return dropped > 0 ? `${reason}; ${dropped} queued message(s) were dropped` : reason;
}

function deliveryFailed(childId: string, error: unknown): void {
  console.error(`[multi-agent] sub-agent ${childId}: message delivery failed`, error);
  const act = activations.get(childId);
  if (act) failActivation(act, `message delivery failed: ${errorText(error)}`);
}

jobs.onJobDone((snapshot) => {
  const act = activations.get(snapshot.owner);
  if (act) wake(act);
});

// worker 后台孙代理不在 ownedChildren 里（没有 Activation），结束时按父会话 id 叫醒。
onChildRunEvent((event) => {
  const act = activations.get(event.parentSessionId);
  if (act) wake(act);
});

function hasLiveWork(act: ActivationRecord): boolean {
  return act.ownedChildren.size > 0 || hasBlockingBash(act) || hasRunningChildren(act.childId);
}

function hasBlockingBash(act: ActivationRecord): boolean {
  if (!act.bashTimeouts?.size) return jobs.hasLive(act.childId);
  if ([...act.bashTimeouts.values()].some((timeout) => timeout.confirmed === undefined)) return true;
  return jobs.liveWithActivity(act.childId).some((job) => act.bashTimeouts?.get(job.id)?.job.startedAt !== job.startedAt);
}

function updateBashPhase(act: ActivationRecord, waiting: boolean): void {
  if (waiting === (act.waitingForBashSince !== undefined)) return;
  act.waitingForBashSince = waiting ? Date.now() : undefined;
  try {
    const reply = waiting ? extractAssistantOutput(act.session.messages as Parameters<typeof extractAssistantOutput>[0], {
      skipPrefix: inheritedSkipPrefix(act),
    }).output : undefined;
    act.onBashPhase?.(waiting ? { phase: "waiting-for-bash" } : null, reply);
  } catch (error) {
    console.error(`[multi-agent] sub-agent ${act.childId}: recording Bash wait phase failed`, error);
  }
}

const BASH_STOP_CONFIRM_MS = 10_000;

/** 只有本轮真的正常结束并进入等待，才用 job 进展而不是会话心跳。 */
export function activationIsWaitingForBash(childId: string): boolean {
  const act = activations.get(childId);
  return act !== undefined && act.waitingForBashSince !== undefined &&
    !act.failure && !act.inbox.closing && !act.poked && !act.inbox.hasPending && isSessionIdle(act.session);
}

/** The generic session reaper must not race the owner-scoped Bash drain policy. */
export function reapWaitingBash(childId: string, thresholdMs: number): boolean {
  const act = activations.get(childId);
  if (!act || act.waitingForBashSince === undefined) return false;
  void childLock.run(childId, async () => {
    const waitingSince = act.waitingForBashSince;
    if (waitingSince === undefined || activations.get(childId) !== act || !activationIsWaitingForBash(childId)) return;
    const now = Date.now();
    for (const job of jobs.liveWithActivity(childId)) {
      if (job.status !== "running" || now - Math.max(waitingSince, job.lastActivityAt) < thresholdMs) continue;
      if (act.bashTimeouts?.get(job.id)?.job.startedAt === job.startedAt) continue;
      const stop = jobs.stopForSubagentTimeout(job.id, childId, job.startedAt);
      if (!stop) continue;
      const timeout: BashTimeout = { job };
      (act.bashTimeouts ??= new Map()).set(job.id, timeout);
      const finish = (confirmed: boolean) => {
        if (timeout.confirmed !== undefined) return;
        clearTimeout(timer);
        timeout.confirmed = confirmed;
        wake(act);
      };
      const timer = setTimeout(() => finish(false), BASH_STOP_CONFIRM_MS);
      timer.unref?.();
      void stop.confirmed.then(finish, () => finish(false));
    }
  }).catch((error: unknown) => {
    console.error(`[multi-agent] sub-agent ${childId}: checking background command timeout failed`, error);
  });
  return true;
}

/**
 * 这个子代理还有没结束的活（自己派的子代理、后台任务）：它这一轮结束后不会马上结算，父会话也就不会被结算通知叫醒。
 * send_message wake: false 交最终结果时据此改成唤醒投递，免得父会话一直睡着。
 */
export function activationHasLiveWork(childId: string): boolean {
  const act = activations.get(childId);
  return act !== undefined && hasLiveWork(act);
}

/** 先交父会话宿主；没有宿主时交给 spawn 时给的退路。 */
function notifyParent(act: ActivationRecord, notice: SettlementNotice): void {
  if (sendSettlementToParent(act.parentSessionPath, act.workspace, notice)) return;
  try {
    act.deliverFallback?.(notice);
  } catch {
    /* 父会话已经不在 */
  }
}

/** 激活结束时撤掉它登记的东西。每一步单独收，失败记进 teardown，后面照做。 */
function unlinkFromParent(act: ActivationRecord, teardown: Teardown): void {
  teardown.step("stop round tracking", () => act.offRound?.());
  teardown.step("stop leak attribution", () => act.offLeak?.());
  act.offLeak = undefined;
  teardown.step("unregister session host", () => act.unregisterHost?.());
  act.unregisterHost = undefined;
  teardown.step("unregister approval route", () => act.unregisterApproval?.());
  act.unregisterApproval = undefined;
  if (!act.parentActivationId) return;
  const parent = activations.get(act.parentActivationId);
  if (!parent || !parent.ownedChildren.delete(act.childId)) return;
  teardown.step("wake parent", () => wake(parent));
}

function delayTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitUntilBusyOrClosing(act: ActivationRecord, epoch: number): Promise<void> {
  while (watchEpoch === epoch && activations.get(act.childId) === act) {
    if (act.inbox.closing) return;
    if (isBusy(act)) {
      abortIfFailed(act);
      return;
    }
    // 出过错、手上又没有还在 preflight 的消息（比如消息没送到）：会话不会再忙起来，不能一直等。
    // 还有在 preflight 的就接着等：等它跑起来再中断，否则它会在结算之后跑在驻留的会话上。
    if (act.failure && act.inbox.inFlight === 0) return;
    await delayTick();
  }
}

function startWatch(act: ActivationRecord): void {
  if (act.watching) return;
  act.watching = true;
  if (act.poked && !act.round) act.mustWaitForBusy = true;
  abortIfFailed(act);
  const epoch = watchEpoch;
  // 监视本身出错（等空闲被拒、收尾抛错）：不能让这个子代理一直挂在「运行中」，按 error 强制结算。
  watchSettlement(act, epoch).catch((error: unknown) => {
    console.error(`[multi-agent] sub-agent ${act.childId}: settlement watch failed`, error);
    void forceSettle(act, `settlement failed: ${errorText(error)}`);
  });
}

/** 还没结算的激活按 error 结算。子代理锁里做，和正常结算、取消互斥。 */
async function forceSettle(act: ActivationRecord, diagnostic: string): Promise<void> {
  try {
    await childLock.run(act.childId, async () => {
      if (activations.get(act.childId) !== act) return;
      let output = "";
      try {
        output = extractAssistantOutput(act.session.messages as Parameters<typeof extractAssistantOutput>[0], {
          skipPrefix: inheritedSkipPrefix(act),
        }).output;
      } catch {
        /* 取不到收尾消息就不带 */
      }
      await settleNow(act, { stopReason: "error", output, diagnostic: failureDiagnostic(act, act.failure ?? diagnostic) });
    });
  } catch (error) {
    console.error(`[multi-agent] sub-agent ${act.childId}: forced settlement failed`, error);
  }
}

/**
 * 结算：释放会话（驻留或销毁）、撤登记、通知父会话、记账。每一步单独收，一步失败不挡后面的
 * （DSH 的释放边界）；结算结果仍按子代理自己的结果。
 */
async function settleNow(
  act: ActivationRecord,
  outcome: Omit<ActivationSettledInfo, "childId" | "sessionPath">,
): Promise<void> {
  const teardown = new Teardown(act.childId);
  await teardown.stepAsync("release session", () =>
    act.inbox.close(async () => {
      if (!parkResident(act)) act.session.dispose();
    }),
  );
  activations.delete(act.childId);
  unlinkFromParent(act, teardown);
  teardown.step("record result", () =>
    act.onSettled?.({ childId: act.childId, sessionPath: act.sessionPath, ...outcome }),
  );
  if (act.announced) {
    teardown.step("notify parent", () =>
      notifyParent(
        act,
        formatSettlementNotice({
          childId: act.childId,
          ...outcome,
          sessionPath: act.sessionPath,
        }),
      ),
    );
    teardown.step("mark settled", () =>
      markChildSettled({
        childId: act.childId, parentSessionId: act.parentSessionId, stopReason: outcome.stopReason,
        ...(outcome.bashTimeout ? { reason: outcome.bashTimeout.reason } : {}),
      }),
    );
  } else {
    teardown.step("mark gone", () => markChildGone(act.childId));
  }
  teardown.report();
}

async function watchSettlement(act: ActivationRecord, epoch: number): Promise<void> {
  while (watchEpoch === epoch && activations.get(act.childId) === act) {
    if (act.mustWaitForBusy) {
      await waitUntilBusyOrClosing(act, epoch);
      act.mustWaitForBusy = false;
      if (watchEpoch !== epoch || activations.get(act.childId) !== act) return;
      if (act.inbox.closing) return;
    }
    await act.session.waitForIdle();
    if (watchEpoch !== epoch || activations.get(act.childId) !== act) return;
    const stop = await childLock.run(act.childId, async () => {
      if (watchEpoch !== epoch || activations.get(act.childId) !== act) return true;
      if (act.inbox.closing) return true;
      if (act.skipSettle) {
        act.skipSettle = false;
        act.mustWaitForBusy = true;
        return false;
      }
      // 出过错的：中断后排着的消息不会再被处理（SDK 的 abort 不清队列），不再等它们，直接结算。
      if (act.inbox.hasPending && !act.failure) return false;
      if (act.poked && !act.failure) {
        act.poked = false;
        return false;
      }
      const waiting = !act.failure && act.round?.completed === true && hasBlockingBash(act);
      updateBashPhase(act, waiting);
      if (hasLiveWork(act)) return "wait" as const;
      const { output, stopReason } = extractAssistantOutput(
        act.session.messages as Parameters<typeof extractAssistantOutput>[0],
        { skipPrefix: inheritedSkipPrefix(act) },
      );
      const bashTimeout: BackgroundBashTimeout | undefined =
        stopReason === "completed" && act.round?.completed && act.bashTimeouts?.size
          ? {
              reason: "background-bash-timeout", replyCompleted: true,
              jobs: [...act.bashTimeouts.values()].map(({ job, confirmed }) => ({
                id: job.id, label: job.label, stopConfirmed: confirmed === true,
              })),
            }
          : undefined;
      await settleNow(
        act,
        act.failure ? { stopReason: "error", output, diagnostic: failureDiagnostic(act, act.failure) }
          : bashTimeout ? { stopReason: "error", output, bashTimeout } : { stopReason, output },
      );
      return true;
    });
    if (stop === true) return;
    if (stop === "wait") {
      await new Promise<void>((resolve) => {
        act.wakers.push(resolve);
        if (
          activations.get(act.childId) !== act ||
          !isSessionIdle(act.session) ||
          (act.waitingForBashSince !== undefined && !hasBlockingBash(act)) ||
          !hasLiveWork(act)
        ) {
          wake(act);
        }
      });
    }
  }
}

export function installActivation(input: {
  childId: string;
  sessionPath: string;
  parentSessionId: string;
  parentSessionPath: string;
  workspace: string;
  session: AgentSessionLike;
  sessionManager?: {
    appendCustomEntry: (type: string, data: unknown) => void;
    getEntries: () => unknown[];
  };
  announced?: boolean;
  depth?: number;
  parentActivationId?: string;
  /** Natural first-idle settlement only. cancel / rollback must not call this. */
  onSettled?: (info: ActivationSettledInfo) => void;
  onBashPhase?: (state: SubagentBashState | null, reply?: string) => void;
  /** 父会话没有登记宿主（CLI、worker 进程里的父会话）时，结算通知交给它（发起 spawn 的会话的扩展 API）。 */
  deliverFallback?: (notice: SettlementNotice) => void;
  /** 结算后留在驻留池（进程内会话）。默认 false。 */
  keepResident?: boolean;
  /** 启动时固定的路由域；省略时从会话的 subagent_meta 读（旧会话 ordinary）。 */
  routingMode?: RoutingMode;
}): Activation {
  if (activations.has(input.childId)) {
    throw new SubagentError(`duplicate activation for child ${input.childId}`, "DUPLICATE_CHILD");
  }
  const routingMode =
    input.routingMode ?? routingModeFromMeta(lastSubagentMeta(input.sessionManager?.getEntries?.() ?? []));
  const domain = domainOf(input.workspace, domainCwd(input.sessionManager), routingMode);
  const act: ActivationRecord = {
    childId: input.childId,
    sessionPath: input.sessionPath,
    parentSessionId: input.parentSessionId,
    parentSessionPath: input.parentSessionPath,
    workspace: input.workspace,
    mode: "continuable",
    session: input.session,
    tracksBashExit: input.keepResident === true,
    sessionManager: input.sessionManager,
    routingMode,
    // 续聊 / 驻留之后的每一轮都在这个域里起，不跟着投递方（父会话）当下的 ALS。
    inbox: new SubagentInbox(
      {
        get isStreaming() {
          return input.session.isStreaming;
        },
        get pendingMessageCount() {
          return input.session.pendingMessageCount;
        },
        prompt: (text, opts) => inDomain(domain, () => input.session.prompt(text, opts)),
      },
      (error) => deliveryFailed(input.childId, error),
    ),
    announced: input.announced === true,
    ownedChildren: new Set(),
    depth: input.depth ?? 0,
    parentActivationId: input.parentActivationId,
    poked: false,
    watching: false,
    mustWaitForBusy: false,
    skipSettle: false,
    wakers: [],
    onSettled: input.onSettled,
    onBashPhase: input.onBashPhase,
    deliverFallback: input.deliverFallback,
    keepResident: input.keepResident === true,
  };
  activations.set(input.childId, act);
  if (act.parentActivationId) {
    const parent = activations.get(act.parentActivationId);
    if (parent) {
      if (parent.inbox.closing) {
        activations.delete(act.childId);
        throw new SubagentError(`parent activation ${act.parentActivationId} is draining`, "DRAINING");
      }
      parent.ownedChildren.add(act.childId);
    }
  }
  // 激活期间这个子代理的漏网错误：中断这一轮，结算时按 error（leak-owner.ts）。
  act.offLeak = onLeakedError(act.childId, (error) => failActivation(act, leakedErrorText(error)));
  if (act.keepResident) {
    act.offRound = act.session.subscribe?.((event) => {
      if (event.type === "agent_start") {
        act.round = { finalReply: false, completed: false };
        act.mustWaitForBusy = false;
        updateBashPhase(act, false);
        wake(act);
      } else if (event.type === "agent_end" && act.round) {
        const last = event.messages.at(-1);
        act.round.finalReply = !event.willRetry && last?.role === "assistant" && last.stopReason === "stop";
      } else if (event.type === "agent_settled" && act.round) {
        act.round.completed = !event.aborted && act.round.finalReply;
        wake(act);
      }
    });
  }
  // 作为父会话被唤起（孙代理的结算通知、send_message）时，这一轮算它自己的。
  act.unregisterHost = registerParentSessionHost({
    sessionId: act.childId,
    sessionPath: act.sessionPath,
    workspace: act.workspace,
    isBusy: () => !isSessionIdle(act.session),
    isDraining: () => act.inbox.closing !== undefined,
    // 不等结果：结算通知是尽力投递，worker 已经退出时这里的拒绝要吞掉，不能变成未处理的 rejection。
    sendMessage: (msg, opts) =>
      runAsChild(act.childId, () =>
        inDomain(domain, () => {
          void Promise.resolve(act.session.sendCustomMessage?.(msg, opts)).catch(() => {});
        }),
      ),
    prompt: (text, delivery) => runAsChild(act.childId, () => deliverToChild(act.childId, text, delivery)),
  });
  // 驻留后续聊、冷恢复都重新装 Activation，所以审批路由跟着 Activation 登记。
  act.unregisterApproval = registerChildApprovalRoute({
    sessionPath: act.sessionPath,
    parentSessionPath: act.parentSessionPath || undefined,
    agentId: act.childId,
    label: metaString(lastSubagentMeta(act.sessionManager?.getEntries?.() ?? []) ?? {}, "label") ?? "",
  });
  if (act.announced) startWatch(act);
  return act;
}

export function markAnnounced(childId: string): void {
  const act = activations.get(childId);
  if (!act) return;
  act.announced = true;
  markChildRunning(childId, act.parentSessionId);
  poke(act);
  startWatch(act);
}

export function getActivation(childId: string): Activation | undefined {
  return activations.get(childId);
}

export function getActivationBySessionPath(sessionPath: string): Activation | undefined {
  const path = typeof sessionPath === "string" ? sessionPath.trim() : "";
  if (!path) return undefined;
  for (const act of activations.values()) {
    if (act.sessionPath === path) return act;
  }
  return undefined;
}

export function deliverToChild(childId: string, text: string, delivery: Delivery): void {
  const act = activations.get(childId);
  if (!act) {
    throw new SubagentError(`no in-process activation for child ${childId}`, "NO_ACTIVATION");
  }
  if (act.inbox.closing) {
    throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
  }
  // 出过错的这一次激活马上要按 error 结算：不再收消息，免得它排在已经中断的会话里，结算后跟着进驻留池。
  if (act.failure) {
    throw new SubagentError(
      `child ${childId} failed (${act.failure}) and is settling; the message was not accepted. Wait for its settlement notice, then send again.`,
      "ACTIVATION_FAILED",
    );
  }
  poke(act);
  childLock
    .run(childId, async () => {
      const current = activations.get(childId);
      if (!current || current.inbox.closing) return;
      if (current.failure) {
        console.error(`[multi-agent] sub-agent ${childId}: dropped a message that arrived after it failed`);
        return;
      }
      // 这一轮由别人（父代理的 send_message、主进程）唤起，但它是这个子代理的：错误归它。
      runAsChild(childId, () => current.inbox.deliver(text, delivery));
      poke(current);
    })
    .catch((error: unknown) => deliveryFailed(childId, error));
}

export function interruptChild(childId: string): void {
  const act = activations.get(childId);
  if (!act) return;
  act.skipSettle = true;
  abortQuietly(act.session);
}

export async function disposeActivation(
  childId: string,
  reason: "settled" | "cancel" | "rollback",
): Promise<void> {
  const owned = activations.get(childId)?.ownedChildren;
  // 子先父后；一个孙代理释放失败不挡别的。
  for (const id of owned ? [...owned] : []) {
    try {
      await disposeActivation(id, "cancel");
    } catch (error) {
      console.error(`[multi-agent] sub-agent ${id}: dispose failed`, error);
    }
  }
  await childLock.run(childId, async () => {
    const act = activations.get(childId);
    if (!act) return;
    const announced = act.announced;
    const teardown = new Teardown(childId);
    await teardown.stepAsync("release session", () =>
      act.inbox.close(async () => {
        act.session.dispose();
      }),
    );
    activations.delete(childId);
    teardown.step("wake waiters", () => wake(act));
    unlinkFromParent(act, teardown);
    if (reason === "cancel" && announced) {
      teardown.step("notify parent", () => {
        const { output } = extractAssistantOutput(
          act.session.messages as Parameters<typeof extractAssistantOutput>[0],
          { skipPrefix: inheritedSkipPrefix(act) },
        );
        notifyParent(
          act,
          formatSettlementNotice({
            childId: act.childId,
            stopReason: "aborted",
            output,
            sessionPath: act.sessionPath,
          }),
        );
      });
      teardown.step("mark settled", () =>
        markChildSettled({ childId: act.childId, parentSessionId: act.parentSessionId, stopReason: "aborted" }),
      );
    } else {
      teardown.step("mark gone", () => markChildGone(act.childId));
    }
    teardown.report();
  });
}

export async function drainByParent(parentSessionPath: string): Promise<void> {
  const ids: string[] = [];
  for (const act of activations.values()) {
    if (act.parentSessionPath === parentSessionPath) ids.push(act.childId);
  }
  for (const id of ids) {
    await disposeActivation(id, "cancel");
  }
  disposeResidentsWhere((r) => r.parentSessionPath === parentSessionPath);
}

export function authorizeParent(activation: Activation, workspace: string): void {
  if (activation.workspace !== workspace) {
    throw new SubagentError(
      `parent is unavailable: activation workspace ${activation.workspace} does not match ${workspace}`,
      "PARENT_UNAVAILABLE",
    );
  }
}

export function writeTornDown(childId: string, sessionPath?: string | null): void {
  try {
    const act = getActivation(childId);
    if (act) {
      if (!act.sessionManager) return;
      const prev = lastSubagentMeta(act.sessionManager.getEntries());
      act.sessionManager.appendCustomEntry("subagent_meta", { ...(prev ?? {}), tornDown: true });
      return;
    }
    const resident = residents.get(childId);
    if (resident?.sessionManager) {
      const prev = lastSubagentMeta(resident.sessionManager.getEntries());
      resident.sessionManager.appendCustomEntry("subagent_meta", { ...(prev ?? {}), tornDown: true });
      disposeResident(childId);
      return;
    }
    disposeResident(childId);
    const path = typeof sessionPath === "string" ? sessionPath.trim() : "";
    if (!path) return;
    const sm = SessionManager.open(path);
    const prev = lastSubagentMeta(sm.getEntries());
    sm.appendCustomEntry("subagent_meta", { ...(prev ?? {}), tornDown: true });
  } catch {
    /* tornDown is best-effort; cancel must still tear down */
  }
}

function inheritedSkipPrefix(act: { sessionManager?: { getEntries?: () => unknown[] } }): number {
  const meta = lastSubagentMeta(act.sessionManager?.getEntries?.() ?? []);
  const n = meta?.inheritedEventCount;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function sessionCwd(sessionManager: unknown): string {
  if (sessionManager && typeof sessionManager === "object") {
    const sm = sessionManager as { cwd?: unknown; getCwd?: () => unknown };
    if (typeof sm.cwd === "string" && sm.cwd.trim()) return sm.cwd;
    if (typeof sm.getCwd === "function") {
      const cwd = sm.getCwd();
      if (typeof cwd === "string" && cwd.trim()) return cwd;
    }
  }
  return process.cwd();
}

/**
 * 子会话的原始项目目录（不是工具 cwd）。
 *
 * 迁移只改 `subagent_meta.workspace` 与历史 cwd 段，会话头 cwd 刻意保持原样（物理身份不变）。
 * 冷恢复的项目归属必须跟着 meta 走，否则又会回到源项目：审批档、模式、资源域都按它算。
 */
function transferredProjectRoot(entries: readonly unknown[], headerCwd: string): string | undefined {
  const root = effectiveProjectRoot(entries, headerCwd);
  return root === headerCwd ? undefined : root;
}

/**
 * 迁移会话的确认位置：迁移在历史尾部追加了自定义行，物理 leaf 变成了追加行。
 * 只有在迁移之后还没有新活动时才回到 metadata.leafId；已经续聊过的沿用当前 leaf。
 * 调用方拿到的 sessionManager 必须支持 getEntry / branch / resetLeaf（SDK 的都有）。
 */
function restoreTransferredLeaf(sessionManager: unknown, entries: readonly unknown[]): void {
  const target = transferredLeafToRestore(entries);
  if (!target?.restore) return;
  const sm = sessionManager as {
    getEntry?: (id: string) => unknown;
    branch?: (id: string) => void;
    resetLeaf?: () => void;
  };
  try {
    if (target.leafId === null) sm.resetLeaf?.();
    else if (target.leafId && sm.getEntry?.(target.leafId)) sm.branch?.(target.leafId);
  } catch {
    /* 位置恢复失败不阻断冷恢复：沿用物理 leaf，下一次用户操作仍可切回 */
  }
}

function metaString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

type SessionLog = {
  getBranch?: () => unknown[];
  getEntries: () => unknown[];
};

/** 会话最后记下的实际模型：优先 model_change（分支），退回 subagent_meta.model（启动时请求的路由）。 */
function lastRecordedModel(
  sessionManager: SessionLog,
  meta: Record<string, unknown>,
): { provider: string; id: string; source: string } | undefined {
  let entries: unknown[] = [];
  try {
    const branch = typeof sessionManager.getBranch === "function" ? sessionManager.getBranch() : undefined;
    entries = Array.isArray(branch) ? branch : sessionManager.getEntries();
  } catch {
    entries = [];
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; provider?: unknown; modelId?: unknown } | undefined;
    if (entry?.type !== "model_change") continue;
    if (typeof entry.provider === "string" && entry.provider.trim() && typeof entry.modelId === "string" && entry.modelId.trim()) {
      return { provider: entry.provider, id: entry.modelId, source: "the session model_change" };
    }
  }
  const recorded = metaString(meta, "model")?.trim();
  if (recorded) {
    const slash = recorded.indexOf("/");
    if (slash > 0 && slash < recorded.length - 1) {
      return { provider: recorded.slice(0, slash), id: recorded.slice(slash + 1), source: "subagent_meta.model" };
    }
  }
  return undefined;
}

/**
 * Ultra 子会话续聊不许自动换模（SDK 在历史模型不可用 / 缺认证时会回退到别的模型）。
 * 这里按会话记录把模型显式解析回来：必须在当前目录可用且已配认证，否则明确报错、不启动。
 */
function resumeUltraModel(
  runtime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">,
  recorded: { provider: string; id: string; source: string },
): Model<Api> {
  const route = `${recorded.provider}/${recorded.id}`;
  const model = runtime.getModel?.(recorded.provider, recorded.id);
  if (!model) {
    throw new Error(
      `ultra sub-agent: cannot resume with ${recorded.source} ${route}: the model is not available in this workspace. ` +
        "Ultra sessions keep their routed model and do not switch to another one; restore that provider/model or spawn a new sub-agent.",
    );
  }
  if (!runtime.hasConfiguredAuth(recorded.provider)) {
    throw new Error(
      `ultra sub-agent: cannot resume with ${recorded.source} ${route}: provider ${recorded.provider} has no configured credentials. ` +
        "Ultra sessions keep their routed model and do not switch to another one; configure the provider or spawn a new sub-agent.",
    );
  }
  return model;
}

export interface ResumedChildSession {
  session: AgentSessionLike;
  sessionManager: NonNullable<Activation["sessionManager"]>;
  /** 会话头里的原始目录。 */
  cwd: string;
  /** 这个子会话固定的路由域；worker 里接着用它，不随父会话后来切模式改变。 */
  routingMode: RoutingMode;
  /** 撤掉打开时登记的审批路由（worker 进程里由 worker-host 在 dispose 时调用）。 */
  unsub: () => void;
}

/** 从子会话 JSONL 在本进程里重建会话并绑定扩展。worker 进程里的 worker-host 也用它。 */
export async function openResumedChildSession(
  sessionPath: string,
  opened?: ReturnType<typeof SessionManager.open>,
): Promise<ResumedChildSession> {
  const sessionManager = opened ?? SessionManager.open(sessionPath);
  const entries = sessionManager.getEntries();
  // 迁移过的子会话：先把用户确认的 leaf 恢复回来，再决定域／快照；之后的追加不会改写旧历史。
  restoreTransferredLeaf(sessionManager, entries);
  // 迁移记录是项目归属的权威；未迁移会话仍按 subagent_meta.workspace / 会话头 cwd（原行为）。
  const cwd = sessionCwd(sessionManager);
  const meta = lastSubagentMeta(entries) ?? {};
  const transferRoot = transferredProjectRoot(entries, cwd);
  // 域按会话自己落的标记重建（旧会话没有标记 → ordinary），不看父会话当下的模式。
  const routingMode = routingModeFromMeta(meta);
  // SDK 扩展初始化与后续新轮都在这个子会话自己的域里跑：父会话可能已经切了模式、换了 ALS，
  // 而子会话的选模来源必须还是它启动时那一份。
  const domain = routingWorkspaceContext(routingMode, {
    workspace: transferRoot ?? metaString(meta, "workspace") ?? cwd,
    cwd,
  });
  const modelRuntime = sharedModelRuntime();
  const budgetAgentDir = getAgentDir();
  // 资源／规则／技能按项目根加载：迁移过的子会话必须从目标项目取，而不是仍带源编码的会话头 cwd。
  // 未迁移会话行为不变（仍用会话头 cwd）。
  const services = await runInWorkspace(domain, () =>
    createAgentSessionServices({
      cwd: transferRoot ?? cwd,
      agentDir: budgetAgentDir,
      ...(modelRuntime ? { modelRuntime } : {}),
    }),
  );
  services.modelRuntime=guardModelInputLimits(observeModelRuntime(services.modelRuntime,{identity:()=>({sessionId:sessionManager.getSessionId(),sessionPath:sessionManager.getSessionFile()})}),{modelsPath:join(getAgentDir(),"models.json")});
  // Ultra 续聊沿用会话记录里的模型（不自动换模）；普通旧恢复保持原行为，不显式传模型。
  // 档位不在这里传：SDK 按会话里的记录恢复，已被选模钳制过一次的不会被重新放大。
  const resumedModel =
    routingMode === "ultra"
      ? runInWorkspace(domain, () => {
          const recorded = lastRecordedModel(sessionManager as unknown as SessionLog, meta);
          if (!recorded) {
            throw new Error(
              "ultra sub-agent: cannot resume without a recorded model. Ultra sessions keep their routed model and do not switch to another one; spawn a new sub-agent instead.",
            );
          }
          return resumeUltraModel(
            services.modelRuntime as unknown as Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">,
            recorded,
          );
        })
      : undefined;
  const { session } = await runInWorkspace(domain, () =>
    createAgentSessionFromServices({
      services,
      sessionManager,
      ...(resumedModel ? { model: resumedModel } : {}),
    }),
  );
  // 迁移过的子会话：资源按目标项目加载（见上面的 services cwd），工具 cwd 仍按最后一条记录恢复；
  // 记录在迁移之前时由共享 helper 落到目标根，不会把旧项目子目录重新带回来。
  attachModelCompactionControl(session, cwd, budgetAgentDir);
  attachUsageEntryTracking(session,getAgentDir());
  installToolRefreshBatching(session);
  // 子会话切过工作目录的，按会话里的 working_directory 记录原地切回去。
  attachSessionCwd(session);
  await runInWorkspace(domain, () =>
    session.bindExtensions({
      uiContext: noopUi,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => {},
      },
      shutdownHandler: () => {},
    }),
  );
  const unsub = registerChildApprovalRoute({
    sessionPath,
    parentSessionPath: metaString(meta, "parentSessionPath") ?? metaString(meta, "parentSession"),
    agentId: metaString(meta, "agentId") ?? "",
    label: metaString(meta, "label") ?? "",
  });
  return {
    // 之后的 prompt / followUp / send_message 也按这个域执行，而不是投递时父会话的 ALS。
    session: bindRoutingDomain(session, domain) as AgentSessionLike,
    sessionManager,
    cwd,
    routingMode,
    unsub,
  };
}

/** 不唤醒地投递（send_message wake: false）时写进对方上下文的那条消息。 */
export const AGENT_MESSAGE_TYPE = "agent-message";

export interface AgentMessage {
  customType: string;
  content: string;
  display: boolean;
  details: Record<string, unknown>;
}

export function agentMessage(senderId: string, message: string): AgentMessage {
  return {
    customType: AGENT_MESSAGE_TYPE,
    content: `Agent ${senderId} sent a message without waking you:\n${message}`,
    display: true,
    details: { from: senderId },
  };
}

/**
 * send_message wake: false 交给子代理：不让它因此开新的一轮。
 * - 会话在内存里（活着的 Activation，或在驻留池里）：`sendCustomMessage(…, { triggerTurn: false })`。
 *   空闲时立即追加；正在跑时 SDK 把它排到这一步的工具结果之后（turn_end）再追加，下一次模型调用就能看到。
 *   跑没跑由持有会话的那个进程当场判断，不会像先查 isStreaming 再 steer 那样，在这一轮刚好结束时变成新开一轮。
 * - 已卸载：宿主直接往它的 JSONL 追加一条（和 writeTornDown 一样，这时没有别的写者），不加载会话、不起 worker；
 *   下次被唤醒或冷恢复时这条就在上下文里。
 * 和冷恢复用同一把子代理锁，两者不会交错（交错时消息会落到会话树的支线上，下次读不到）。
 * 返回 next-step（对方正在跑）或 appended（对方空闲 / 已卸载），只用于回执措辞。
 */
export function deliverWithoutWaking(
  childId: string,
  input: { sessionPath?: string; message: AgentMessage },
): Promise<"next-step" | "appended"> {
  return childLock.run(childId, async () => {
    const act = activations.get(childId);
    if (act) {
      if (act.inbox.closing) {
        throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
      }
      if (!act.session.sendCustomMessage) throw new SubagentError(`child ${childId} cannot take messages`, "NO_ACTIVATION");
      const running = act.session.isStreaming === true;
      await inDomain(domainOf(act.workspace, domainCwd(act.sessionManager), act.routingMode), () =>
        act.session.sendCustomMessage!(input.message, { triggerTurn: false }),
      );
      return running ? "next-step" : "appended";
    }
    const warm = residents.get(childId);
    if (warm) {
      // 驻留的会话还持有 JSONL：只能经它写，不能绕过它直接追加文件。
      if (!warm.session.sendCustomMessage) throw new SubagentError(`child ${childId} cannot take messages`, "NO_ACTIVATION");
      await inDomain(domainOf(warm.workspace, domainCwd(warm.sessionManager), warm.routingMode), () =>
        warm.session.sendCustomMessage!(input.message, { triggerTurn: false }),
      );
      // 刚收到消息，多半很快会被叫醒：不要马上被挤出驻留池。
      warm.lastUsed = Date.now();
      return "appended";
    }
    const sessionPath = input.sessionPath;
    if (!sessionPath) throw new SubagentError(`child ${childId} is not resumable`, "NOT_RESUMABLE");
    const sessionManager = SessionManager.open(sessionPath);
    if (!isResumableMeta(lastSubagentMeta(sessionManager.getEntries()))) {
      throw new SubagentError(`child ${childId} is not resumable`, "NOT_RESUMABLE");
    }
    sessionManager.appendCustomMessageEntry(input.message.customType, input.message.content, input.message.display, input.message.details);
    return "appended";
  });
}

/** 冷恢复（或从驻留池取出）并投递。和 deliverWithoutWaking 共用子代理锁。 */
export function coldResumeAndDeliver(
  childId: string,
  sessionPath: string,
  text: string,
  delivery: Delivery,
  link: ResumeLink = {},
): Promise<void> {
  // 重建会话、投递、开始监视都算这个子代理的（漏网错误归属，leak-owner.ts）。
  return childLock.run(childId, () => runAsChild(childId, () => resumeAndDeliver(childId, sessionPath, text, delivery, link)));
}

async function resumeAndDeliver(
  childId: string,
  sessionPath: string,
  text: string,
  delivery: Delivery,
  link: ResumeLink,
): Promise<void> {
  const registry = link.registry;
  const accounting = registry?.get(childId) ? {
    onBashPhase: (state: SubagentBashState | null, reply?: string) => registry.setBashPhase(childId, state, reply),
    onSettled: (info: ActivationSettledInfo) => {
      const status = info.stopReason === "aborted" ? "cancelled" : info.stopReason === "error" ? "error" : "done";
      registry.finish(childId, { status, output: info.output, error: info.diagnostic, exitCode: status === "done" ? 0 : -1, bashState: info.bashTimeout });
    },
  } : undefined;
  const parentLink =
    link.senderActivationId && activations.has(link.senderActivationId) ? { parentActivationId: link.senderActivationId } : {};
  const warm = residents.get(childId);
  if (warm) {
    residents.delete(childId);
    warm.lastUsed = Date.now();
    // 结算时 runner 把 cwd 控制器摘了，重新挂上。
    attachSessionCwd(warm.session as unknown as Parameters<typeof attachSessionCwd>[0]);
    const act = installActivation({
      childId,
      sessionPath: warm.sessionPath,
      parentSessionId: warm.parentSessionId,
      parentSessionPath: warm.parentSessionPath,
      workspace: warm.workspace,
      session: warm.session,
      ...(warm.sessionManager ? { sessionManager: warm.sessionManager } : {}),
      announced: false,
      depth: warm.depth,
      routingMode: warm.routingMode,
      keepResident: true,
      ...accounting,
      ...parentLink,
    });
    if (accounting) registry?.finish(childId, { status: "running" });
    act.inbox.deliver(text, delivery);
    const record = activations.get(childId);
    if (record) poke(record);
    markAnnounced(childId);
    return;
  }
  const sessionManager = SessionManager.open(sessionPath);
  const meta = lastSubagentMeta(sessionManager.getEntries());
  if (!isResumableMeta(meta)) {
    throw new SubagentError(`child ${childId} is not resumable`, "NOT_RESUMABLE");
  }
  // 跑在 worker 里的子代理冷恢复时仍回到 worker（会话本身在 JSONL 里，哪边都能打开）。
  // 动态导入：worker-session 依赖 embedded-runner，后者又依赖本模块。
  const resumed =
    meta.backend === "worker"
      ? await (await import("./worker-session.js")).resumeWorkerChildSession(sessionPath, childId)
      : await openResumedChildSession(sessionPath, sessionManager);
  const { session, cwd } = resumed;
  const act = installActivation({
    childId,
    sessionPath,
    parentSessionId: metaString(meta, "parentSessionId") ?? "",
    parentSessionPath: metaString(meta, "parentSessionPath") ?? metaString(meta, "parentSession") ?? "",
    workspace: metaString(meta, "workspace") ?? cwd,
    session,
    sessionManager: resumed.sessionManager,
    announced: false,
    routingMode: resumed.routingMode,
    keepResident: meta.backend !== "worker",
    ...(meta.backend === "worker" ? {} : accounting),
    depth: typeof meta.depth === "number" ? meta.depth : 0,
    ...(link.senderActivationId && activations.has(link.senderActivationId)
      ? { parentActivationId: link.senderActivationId }
      : {}),
  });
  if (meta.backend !== "worker" && accounting) registry?.finish(childId, { status: "running" });
  act.inbox.deliver(text, delivery);
  const record = activations.get(childId);
  if (record) poke(record);
  markAnnounced(childId);
}

export function __resetActivationsForTest(): void {
  watchEpoch += 1;
  for (const act of activations.values()) {
    act.offRound?.();
    wake(act);
  }
  activations.clear();
  for (const r of residents.values()) disposeQuietly(r.session);
  residents.clear();
  retiring.clear();
  __resetChildRunsForTest();
  __resetLeakOwnerForTest();
}
