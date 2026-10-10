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
import { registerParentSessionHost, sendSettlementToParent } from "./parent-host.js";
import { formatSettlementNotice } from "./settlement-notice.js";

export interface AgentSessionLike extends InboxSession {
  messages: unknown[];
  abort: () => Promise<unknown> | unknown;
  dispose: () => void;
  waitForIdle: () => Promise<void>;
  sendCustomMessage?: (
    msg: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    opts: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" },
  ) => void;
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
};

type ActivationRecord = Activation & {
  poked: boolean;
  watching: boolean;
  mustWaitForBusy: boolean;
  skipSettle: boolean;
  unregisterHost?: () => void;
  wakers: Array<() => void>;
  onSettled?: (info: ActivationSettledInfo) => void;
};

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

jobs.onJobDone((snapshot) => {
  const act = activations.get(snapshot.owner);
  if (act) wake(act);
});

function unlinkFromParent(act: ActivationRecord): void {
  act.unregisterHost?.();
  act.unregisterHost = undefined;
  if (!act.parentActivationId) return;
  const parent = activations.get(act.parentActivationId);
  if (!parent || !parent.ownedChildren.delete(act.childId)) return;
  wake(parent);
}

function delayTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitUntilBusyOrClosing(act: ActivationRecord, epoch: number): Promise<void> {
  while (watchEpoch === epoch && activations.get(act.childId) === act) {
    if (act.inbox.closing) return;
    if (!isSessionIdle(act.session) || act.session.isStreaming === true) return;
    await delayTick();
  }
}

function startWatch(act: ActivationRecord): void {
  if (act.watching) return;
  act.watching = true;
  if (act.poked) act.mustWaitForBusy = true;
  const epoch = watchEpoch;
  void watchSettlement(act, epoch);
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
      if (act.inbox.hasPending) return false;
      if (act.ownedChildren.size > 0 || jobs.hasLive(act.childId)) return "wait" as const;
      if (act.poked) {
        act.poked = false;
        return false;
      }
      const { output, stopReason } = extractAssistantOutput(
        act.session.messages as Parameters<typeof extractAssistantOutput>[0],
        { skipPrefix: inheritedSkipPrefix(act) },
      );
      await act.inbox.close(async () => {
        act.session.dispose();
      });
      activations.delete(act.childId);
      unlinkFromParent(act);
      if (act.announced) {
        sendSettlementToParent(
          act.parentSessionPath,
          act.workspace,
          formatSettlementNotice({
            childId: act.childId,
            stopReason,
            output,
            sessionPath: act.sessionPath,
          }),
        );
      }
      try {
        act.onSettled?.({
          childId: act.childId,
          stopReason,
          output,
          sessionPath: act.sessionPath,
        });
      } catch {
        /* onSettled must not break watch */
      }
      return true;
    });
    if (stop === true) return;
    if (stop === "wait") {
      await new Promise<void>((resolve) => {
        act.wakers.push(resolve);
        if (
          activations.get(act.childId) !== act ||
          (act.ownedChildren.size === 0 && !jobs.hasLive(act.childId))
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
    inbox: new SubagentInbox(input.session),
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
  act.unregisterHost = registerParentSessionHost({
    sessionId: act.childId,
    sessionPath: act.sessionPath,
    workspace: act.workspace,
    isBusy: () => !isSessionIdle(act.session),
    isDraining: () => act.inbox.closing !== undefined,
    sendMessage: (msg, opts) => act.session.sendCustomMessage?.(msg, opts),
    prompt: (text, delivery) => deliverToChild(act.childId, text, delivery),
  });
  if (act.announced) startWatch(act);
  return act;
}

export function markAnnounced(childId: string): void {
  const act = activations.get(childId);
  if (!act) return;
  act.announced = true;
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
  poke(act);
  void childLock.run(childId, async () => {
    const current = activations.get(childId);
    if (!current || current.inbox.closing) return;
    current.inbox.deliver(text, delivery);
    poke(current);
  });
}

export function interruptChild(childId: string): void {
  const act = activations.get(childId);
  if (!act) return;
  act.skipSettle = true;
  void act.session.abort();
}

export async function disposeActivation(
  childId: string,
  reason: "settled" | "cancel" | "rollback",
): Promise<void> {
  const owned = activations.get(childId)?.ownedChildren;
  for (const id of owned ? [...owned] : []) {
    await disposeActivation(id, "cancel");
  }
  await childLock.run(childId, async () => {
    const act = activations.get(childId);
    if (!act) return;
    const announced = act.announced;
    await act.inbox.close(async () => {
      act.session.dispose();
    });
    activations.delete(childId);
    wake(act);
    unlinkFromParent(act);
    if (reason === "cancel" && announced) {
      const { output } = extractAssistantOutput(
        act.session.messages as Parameters<typeof extractAssistantOutput>[0],
        { skipPrefix: inheritedSkipPrefix(act) },
      );
      sendSettlementToParent(
        act.parentSessionPath,
        act.workspace,
        formatSettlementNotice({
          childId: act.childId,
          stopReason: "aborted",
          output,
          sessionPath: act.sessionPath,
        }),
      );
    }
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
}

export function authorizeParent(activation: Activation, workspace: string): void {
  if (activation.workspace !== workspace) {
    throw new SubagentError(
      `parent is unavailable: activation workspace ${activation.workspace} does not match ${workspace}`,
      "PARENT_UNAVAILABLE",
    );
  }
}

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: Record<string, unknown>;
};

export function writeTornDown(childId: string, sessionPath?: string | null): void {
  try {
    const act = getActivation(childId);
    if (act) {
      if (!act.sessionManager) return;
      const prev = lastSubagentMeta(act.sessionManager.getEntries());
      act.sessionManager.appendCustomEntry("subagent_meta", { ...(prev ?? {}), tornDown: true });
      return;
    }
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

function lastSubagentMeta(entries: unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const item = entry as SessionEntry;
    if (item?.type === "custom" && item.customType === "subagent_meta" && item.data && typeof item.data === "object") {
      found = item.data;
    }
  }
  return found;
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

export async function coldResumeAndDeliver(
  childId: string,
  sessionPath: string,
  text: string,
  delivery: Delivery,
  link: { senderActivationId?: string } = {},
): Promise<void> {
  const sessionManager = SessionManager.open(sessionPath);
  const entries = sessionManager.getEntries();
  const meta = lastSubagentMeta(entries);
  if (!meta || meta.mode !== "continuable" || meta.tornDown === true) {
    throw new SubagentError(`child ${childId} is not resumable`, "NOT_RESUMABLE");
  }
  const cwd = sessionCwd(sessionManager);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
  });
  installToolRefreshBatching(session);
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
  const act = installActivation({
    childId,
    sessionPath,
    parentSessionId: metaString(meta, "parentSessionId") ?? "",
    parentSessionPath: metaString(meta, "parentSessionPath") ?? metaString(meta, "parentSession") ?? "",
    workspace: metaString(meta, "workspace") ?? cwd,
    session: session as AgentSessionLike,
    sessionManager,
    announced: false,
    depth: typeof meta.depth === "number" ? meta.depth : 0,
    ...(link.senderActivationId && activations.has(link.senderActivationId)
      ? { parentActivationId: link.senderActivationId }
      : {}),
  });
  act.inbox.deliver(text, delivery);
  poke(act);
  markAnnounced(childId);
}

export function __resetActivationsForTest(): void {
  watchEpoch += 1;
  activations.clear();
}
