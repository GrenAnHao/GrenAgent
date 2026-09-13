import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { extractAssistantOutput } from "./assistant-output.js";
import {
  SubagentError,
  SubagentInbox,
  type Delivery,
  type InboxSession,
} from "./inbox.js";
import { sendSettlementToParent } from "./parent-host.js";
import { formatSettlementNotice } from "./settlement-notice.js";

export interface AgentSessionLike extends InboxSession {
  messages: unknown[];
  abort: () => Promise<unknown> | unknown;
  dispose: () => void;
  waitForIdle: () => Promise<void>;
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
}

type ActivationRecord = Activation & {
  poked: boolean;
  watching: boolean;
};

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
  custom: async () => undefined,
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

function poke(act: ActivationRecord): void {
  act.poked = true;
}

function startWatch(act: ActivationRecord): void {
  if (act.watching) return;
  act.watching = true;
  const epoch = watchEpoch;
  void watchSettlement(act, epoch);
}

async function watchSettlement(act: ActivationRecord, epoch: number): Promise<void> {
  while (watchEpoch === epoch && activations.get(act.childId) === act) {
    await act.session.waitForIdle();
    if (watchEpoch !== epoch || activations.get(act.childId) !== act) return;
    const stop = await childLock.run(act.childId, async () => {
      if (watchEpoch !== epoch || activations.get(act.childId) !== act) return true;
      if (act.inbox.closing) return true;
      if (act.inbox.hasPending || act.ownedChildren.size > 0) return false;
      if (act.poked) {
        act.poked = false;
        return false;
      }
      const { output, stopReason } = extractAssistantOutput(
        act.session.messages as Parameters<typeof extractAssistantOutput>[0],
      );
      await act.inbox.close(async () => {
        act.session.dispose();
      });
      activations.delete(act.childId);
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
      return true;
    });
    if (stop) return;
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
  announced?: boolean;
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
    inbox: new SubagentInbox(input.session),
    announced: input.announced === true,
    ownedChildren: new Set(),
    poked: false,
    watching: false,
  };
  activations.set(input.childId, act);
  if (act.announced) startWatch(act);
  return act;
}

export function markAnnounced(childId: string): void {
  const act = activations.get(childId);
  if (!act) return;
  act.announced = true;
  startWatch(act);
}

export function getActivation(childId: string): Activation | undefined {
  return activations.get(childId);
}

export function deliverToChild(childId: string, text: string, delivery: Delivery): void {
  const act = activations.get(childId);
  if (!act) {
    throw new SubagentError(`no in-process activation for child ${childId}`, "NO_ACTIVATION");
  }
  if (act.inbox.closing) {
    throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
  }
  void childLock.run(childId, async () => {
    const current = activations.get(childId);
    if (!current || current.inbox.closing) {
      throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
    }
    current.inbox.deliver(text, delivery);
    poke(current);
  });
}

export function interruptChild(childId: string): void {
  const act = activations.get(childId);
  if (!act) return;
  void act.session.abort();
}

export async function disposeActivation(
  childId: string,
  reason: "settled" | "cancel" | "rollback",
): Promise<void> {
  await childLock.run(childId, async () => {
    const act = activations.get(childId);
    if (!act) return;
    const announced = act.announced;
    await act.inbox.close(async () => {
      act.session.dispose();
    });
    activations.delete(childId);
    if (reason === "cancel" && announced) {
      const { output } = extractAssistantOutput(
        act.session.messages as Parameters<typeof extractAssistantOutput>[0],
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
    announced: false,
  });
  act.inbox.deliver(text, delivery);
  markAnnounced(childId);
}

export function __resetActivationsForTest(): void {
  watchEpoch += 1;
  activations.clear();
}
