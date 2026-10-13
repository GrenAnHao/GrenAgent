import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { extractAssistantOutput, type SubagentStopReason } from "./assistant-output.js";
import {
  SubagentError,
  SubagentInbox,
  type Delivery,
  type InboxSession,
} from "./inbox.js";
import { jobs } from "../jobs/service.js";
import { installToolRefreshBatching } from "../_shared/tool-refresh-batch.js";
import { getConfig } from "../_shared/runtime-config.js";
import { attachSessionCwd } from "../_shared/session-cwd.js";
import { registerChildApprovalRoute } from "../_shared/approval-route.js";
import { sharedModelRuntime } from "../_shared/shared-model-runtime.js";
import { registerParentSessionHost, sendSettlementToParent } from "./parent-host.js";
import { __resetLeakOwnerForTest, leakedErrorText, onLeakedError, runAsChild } from "../_shared/leak-owner.js";
import { abortQuietly, errorText, Teardown } from "./teardown.js";
import { formatSettlementNotice, type SettlementNotice } from "./settlement-notice.js";
import { isResumableMeta, lastSubagentMeta } from "./subagent-meta.js";
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
  inbox: SubagentInbox;
  announced: boolean;
  ownedChildren: Set<string>;
  depth: number;
  parentActivationId?: string;
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
};

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
  deliverFallback?: (notice: SettlementNotice) => void;
  /** 结算后会话留着（驻留池），续聊时不必冷恢复。只给进程内会话开，worker 结算即退出。 */
  keepResident: boolean;
  /** 这一次激活里出过漏网错误或消息没送到：结算时按 error，诊断写这一句（leak-owner.ts）。 */
  failure?: string;
  offLeak?: () => void;
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

/** 父会话要换走 / 关掉，或整个工作区要释放：把它们的驻留会话销毁。 */
export function disposeResidentsWhere(match: (r: { parentSessionPath: string; workspace: string }) => boolean): void {
  for (const r of [...residents.values()]) if (match(r)) disposeResident(r.childId);
}

export function residentChildIds(): string[] {
  return [...residents.keys()];
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

function isSessionIdle(session: AgentSessionLike): boolean {
  const idle = (session as IdleAwareSession).isIdle;
  if (typeof idle === "boolean") return idle;
  return !session.isStreaming;
}

function poke(act: ActivationRecord): void {
  act.poked = true;
  if (isSessionIdle(act.session)) act.mustWaitForBusy = true;
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
  return act.ownedChildren.size > 0 || jobs.hasLive(act.childId) || hasRunningChildren(act.childId);
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
  if (act.poked) act.mustWaitForBusy = true;
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
  outcome: { stopReason: SubagentStopReason; output: string; diagnostic?: string },
): Promise<void> {
  const teardown = new Teardown(act.childId);
  await teardown.stepAsync("release session", () =>
    act.inbox.close(async () => {
      if (!parkResident(act)) act.session.dispose();
    }),
  );
  activations.delete(act.childId);
  unlinkFromParent(act, teardown);
  if (act.announced) {
    teardown.step("notify parent", () =>
      notifyParent(
        act,
        formatSettlementNotice({
          childId: act.childId,
          stopReason: outcome.stopReason,
          output: outcome.output,
          sessionPath: act.sessionPath,
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
        }),
      ),
    );
    teardown.step("mark settled", () =>
      markChildSettled({ childId: act.childId, parentSessionId: act.parentSessionId, stopReason: outcome.stopReason }),
    );
  } else {
    teardown.step("mark gone", () => markChildGone(act.childId));
  }
  teardown.step("record result", () =>
    act.onSettled?.({
      childId: act.childId,
      stopReason: outcome.stopReason,
      output: outcome.output,
      sessionPath: act.sessionPath,
      ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
    }),
  );
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
      if (hasLiveWork(act)) return "wait" as const;
      if (act.poked && !act.failure) {
        act.poked = false;
        return false;
      }
      const { output, stopReason } = extractAssistantOutput(
        act.session.messages as Parameters<typeof extractAssistantOutput>[0],
        { skipPrefix: inheritedSkipPrefix(act) },
      );
      await settleNow(
        act,
        act.failure ? { stopReason: "error", output, diagnostic: failureDiagnostic(act, act.failure) } : { stopReason, output },
      );
      return true;
    });
    if (stop === true) return;
    if (stop === "wait") {
      await new Promise<void>((resolve) => {
        act.wakers.push(resolve);
        if (
          activations.get(act.childId) !== act ||
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
  session: InboxSession & {
    messages: unknown[];
    abort: () => Promise<unknown> | unknown;
    dispose: () => void;
    waitForIdle: () => Promise<void>;
  };
  sessionManager?: {
    appendCustomEntry: (type: string, data: unknown) => void;
    getEntries: () => unknown[];
  };
  announced?: boolean;
  depth?: number;
  parentActivationId?: string;
  /** Natural first-idle settlement only. cancel / rollback must not call this. */
  onSettled?: (info: ActivationSettledInfo) => void;
  /** 父会话没有登记宿主（CLI、worker 进程里的父会话）时，结算通知交给它（发起 spawn 的会话的扩展 API）。 */
  deliverFallback?: (notice: SettlementNotice) => void;
  /** 结算后留在驻留池（进程内会话）。默认 false。 */
  keepResident?: boolean;
}): Activation {
  if (activations.has(input.childId)) {
    throw new SubagentError(`duplicate activation for child ${input.childId}`, "DUPLICATE_CHILD");
  }
  const act: ActivationRecord = {
    childId: input.childId,
    sessionPath: input.sessionPath,
    parentSessionId: input.parentSessionId,
    parentSessionPath: input.parentSessionPath,
    workspace: input.workspace,
    mode: "continuable",
    session: input.session,
    sessionManager: input.sessionManager,
    inbox: new SubagentInbox(input.session, (error) => deliveryFailed(input.childId, error)),
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
  // 作为父会话被唤起（孙代理的结算通知、send_message）时，这一轮算它自己的。
  act.unregisterHost = registerParentSessionHost({
    sessionId: act.childId,
    sessionPath: act.sessionPath,
    workspace: act.workspace,
    isBusy: () => !isSessionIdle(act.session),
    isDraining: () => act.inbox.closing !== undefined,
    // 不等结果：结算通知是尽力投递，worker 已经退出时这里的拒绝要吞掉，不能变成未处理的 rejection。
    sendMessage: (msg, opts) =>
      runAsChild(act.childId, () => {
        void Promise.resolve(act.session.sendCustomMessage?.(msg, opts)).catch(() => {});
      }),
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

function metaString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export interface ResumedChildSession {
  session: AgentSessionLike;
  sessionManager: NonNullable<Activation["sessionManager"]>;
  /** 会话头里的原始目录。 */
  cwd: string;
  /** 撤掉打开时登记的审批路由（worker 进程里由 worker-host 在 dispose 时调用）。 */
  unsub: () => void;
}

/** 从子会话 JSONL 在本进程里重建会话并绑定扩展。worker 进程里的 worker-host 也用它。 */
export async function openResumedChildSession(
  sessionPath: string,
  opened?: ReturnType<typeof SessionManager.open>,
): Promise<ResumedChildSession> {
  const sessionManager = opened ?? SessionManager.open(sessionPath);
  const cwd = sessionCwd(sessionManager);
  const modelRuntime = sharedModelRuntime();
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    ...(modelRuntime ? { modelRuntime } : {}),
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
  });
  installToolRefreshBatching(session);
  // 子会话切过工作目录的，按会话里的 working_directory 记录原地切回去。
  attachSessionCwd(session);
  await session.bindExtensions({
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
  });
  const meta = lastSubagentMeta(sessionManager.getEntries()) ?? {};
  const unsub = registerChildApprovalRoute({
    sessionPath,
    parentSessionPath: metaString(meta, "parentSessionPath") ?? metaString(meta, "parentSession"),
    agentId: metaString(meta, "agentId") ?? "",
    label: metaString(meta, "label") ?? "",
  });
  return { session: session as AgentSessionLike, sessionManager, cwd, unsub };
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
      await act.session.sendCustomMessage(input.message, { triggerTurn: false });
      return running ? "next-step" : "appended";
    }
    const warm = residents.get(childId);
    if (warm) {
      // 驻留的会话还持有 JSONL：只能经它写，不能绕过它直接追加文件。
      if (!warm.session.sendCustomMessage) throw new SubagentError(`child ${childId} cannot take messages`, "NO_ACTIVATION");
      await warm.session.sendCustomMessage(input.message, { triggerTurn: false });
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
  link: { senderActivationId?: string } = {},
): Promise<void> {
  // 重建会话、投递、开始监视都算这个子代理的（漏网错误归属，leak-owner.ts）。
  return childLock.run(childId, () => runAsChild(childId, () => resumeAndDeliver(childId, sessionPath, text, delivery, link)));
}

async function resumeAndDeliver(
  childId: string,
  sessionPath: string,
  text: string,
  delivery: Delivery,
  link: { senderActivationId?: string },
): Promise<void> {
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
      keepResident: true,
      ...parentLink,
    });
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
    keepResident: meta.backend !== "worker",
    depth: typeof meta.depth === "number" ? meta.depth : 0,
    ...(link.senderActivationId && activations.has(link.senderActivationId)
      ? { parentActivationId: link.senderActivationId }
      : {}),
  });
  act.inbox.deliver(text, delivery);
  const record = activations.get(childId);
  if (record) poke(record);
  markAnnounced(childId);
}

export function __resetActivationsForTest(): void {
  watchEpoch += 1;
  activations.clear();
  for (const r of residents.values()) disposeQuietly(r.session);
  residents.clear();
  __resetChildRunsForTest();
  __resetLeakOwnerForTest();
}
