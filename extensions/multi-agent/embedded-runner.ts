// In-process one-shot sub-agent: real SessionManager + JSONL in the Electron sidecar.
// High-risk profiles (worktree) and non-Electron hosts fall back to spawnPiAgent in index.ts.

import { type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getConfig, withoutSensitiveProcessConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext, runInWorkspace } from "../_shared/workspace-context.js";
import { continuableReturnGuidance } from "./adjacent-tools.js";
import {
  disposeActivation,
  installActivation,
  markAnnounced,
  type ActivationSettledInfo,
  type AgentSessionLike,
} from "./activation.js";
import { extractAssistantOutput, type SubagentStopReason } from "./assistant-output.js";
import { type CapabilityProfile } from "./capability.js";
import { emitEmbeddedSubagentEvent } from "./embedded-events.js";
import { wipeSessionFile, writeSeed } from "./fork-seed.js";
import { readMaxDepth } from "./depth.js";
import { buildSubagentRuntimeConfig, type AgentResult, type AgentUpdate } from "./runner.js";

export interface EmbeddedSubagentOpts {
  cwd: string;
  task: string;
  agentId: string;
  parentSessionPath?: string;
  parentSessionId?: string | null;
  model?: string;
  systemPrompt?: string;
  /** Named-agent tool allowlist (--tools). */
  tools?: string[];
  env?: Record<string, string>;
  mcp?: boolean | string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (update: AgentUpdate) => void;
  mode?: "one-shot" | "continuable";
  seedMessages?: unknown[];
  thinkingLevel?: ThinkingLevel;
  depth?: number;
  parentActivationId?: string;
}

export interface ContinuableEmbeddedOpts extends EmbeddedSubagentOpts {
  onSettled?: (info: ActivationSettledInfo) => void;
}

export interface EmbeddedChildHandle {
  session: AgentSessionLike & {
    model?: { provider?: string; id?: string };
    sessionId?: string;
    bindExtensions: (opts: unknown) => Promise<unknown>;
    subscribe: (fn: (event: AgentSessionEvent) => void) => () => void;
    prompt: (
      text: string,
      opts?: { source?: string; preflightResult?: (ok: boolean) => void },
    ) => Promise<unknown>;
  };
  sessionManager: {
    appendMessage: (m: unknown) => void;
    appendCustomEntry: (type: string, data: unknown) => void;
    appendModelChange: (provider: string, id: string) => void;
    getSessionFile: () => string | undefined;
    getEntries: () => unknown[];
  };
  sessionPath: string;
  unsub: () => void;
  workspace: string;
}

export interface ContinuableEmbeddedStart {
  agentId: string;
  sessionPath: string;
}

export interface EmbeddedSubagentResult extends AgentResult {
  sessionPath: string;
  stopReason: SubagentStopReason;
}

const CHAT_EXCLUDED = new Set([
  "lsp",
  "dap",
  "ast-tools",
  "hashline",
  "code-exec",
  "debug-tools",
  "diagnostics",
  "after-tool-feedback",
]);

const CORE_ALWAYS_ON = new Set([
  "safety",
  "approval",
  "sandbox",
  "header-placeholders",
  "loop-guard",
  "rulebook",
  "compaction-policy",
  "auto-title",
  "todo",
  "agent-mode",
  "diagram-hint",
  "fable-behavior",
  "session-memory",
  "web-fetch",
  "resource-manager",
  "mcp-policy",
  "image-gen",
  "jobs",
  "multi-agent",
  "github",
  "batch-tools",
  "tts",
  "visual-companion",
]);

async function filterExtensionFactories(): Promise<Array<(...args: never[]) => unknown>> {
  const { manifestExtensions } = await import("../index.js");
  const profile = (getConfig("EXTENSIONS_PROFILE") as "project" | "chat") ?? "project";
  let exts = manifestExtensions;
  if (profile === "chat") {
    exts = exts.filter((e) => e.name === "safety" || !CHAT_EXCLUDED.has(e.name));
  }
  const allowedJson = getConfig("PI_ALLOWED_EXTENSIONS");
  if (allowedJson?.trim()) {
    let ids: unknown;
    try {
      ids = JSON.parse(allowedJson);
    } catch {
      ids = allowedJson.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (Array.isArray(ids) && !ids.some((id) => typeof id !== "string")) {
      const allowed = new Set(ids as string[]);
      exts = exts.filter(
        (entry) => CORE_ALWAYS_ON.has(entry.name) || (entry.manifest !== undefined && allowed.has(entry.manifest.id)),
      );
    }
  }
  return exts.map((x) => x.factory);
}

function buildExcludeTools(env: Record<string, string>, depth: number | undefined): string[] {
  const deny = new Set(["explore_context", "list_subagent_models"]);
  const effective = depth ?? Number(env.SUBAGENT_DEPTH ?? "");
  if (Number.isSafeInteger(effective) && effective >= readMaxDepth()) deny.add("spawn_agent");
  for (const t of (env.SAFETY_DENY_TOOLS ?? "").split(",")) {
    const s = t.trim();
    if (s) deny.add(s);
  }
  return [...deny];
}

/** Electron in-process sidecar; not subprocess sub-agent; not worktree (handled in index). */
export function canUseEmbeddedSubagent(profile: CapabilityProfile): boolean {
  if (profile.isolation === "worktree") return false;
  return typeof process.versions.electron === "string" && process.env.PI_IS_SUBAGENT !== "1";
}

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

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.replace(/\r$/, "").trim();
}

function eventToJsonLine(event: AgentSessionEvent): string {
  try {
    return `${JSON.stringify(event)}\n`;
  } catch {
    return "";
  }
}

function streamingDeltaFromEvent(event: AgentSessionEvent, prev: string): string {
  const ev = event as Record<string, unknown>;
  if (ev.type !== "message_update") return prev;
  const ame = ev.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
  if (ame?.type === "text_delta" && typeof ame.delta === "string") return prev + ame.delta;
  return prev;
}

type PreparedEmbedded = {
  childConfig: Record<string, string>;
  parentPath: string | undefined;
  workspace: string;
  ctx: {
    origin: "subagent";
    workspace: string;
    cwd: string;
    config: Record<string, string>;
  };
  cleanup: () => void;
};

function prepareEmbeddedConfig(opts: EmbeddedSubagentOpts): PreparedEmbedded {
  const rc = buildSubagentRuntimeConfig(opts.mcp, opts.env ?? {});
  const als = currentWorkspaceContext()?.config ?? {};
  const childConfig = withoutSensitiveProcessConfig({
    ...als,
    ...rc.env,
    ...(rc.path ? { PI_RUNTIME_CONFIG: rc.path } : {}),
  });
  const parentPath = opts.parentSessionPath?.trim() || undefined;
  const workspace = currentWorkspaceContext()?.workspace ?? opts.cwd;
  return {
    childConfig,
    parentPath,
    workspace,
    ctx: {
      origin: "subagent",
      workspace,
      cwd: opts.cwd,
      config: childConfig,
    },
    cleanup: rc.cleanup,
  };
}

type OpenedEmbedded = EmbeddedChildHandle & {
  getTranscript: () => string;
  getStreamingDelta: () => string;
  clearEmitTimer: () => void;
  inheritedEventCount: number;
};

async function openEmbeddedChildSession(opts: EmbeddedSubagentOpts, prepared: PreparedEmbedded): Promise<OpenedEmbedded> {
  const sessionManager = SessionManager.create(opts.cwd, undefined, {
    id: opts.agentId,
    ...(prepared.parentPath ? { parentSession: prepared.parentPath } : {}),
  });
  let inheritedEventCount = 0;
  try {
    inheritedEventCount = writeSeed(sessionManager, opts.seedMessages ?? []);
    if (inheritedEventCount > 0) {
      sessionManager.appendCustomEntry("subagent_catalog_base", { version: 0, reason: "subagent-seed" });
    }
    sessionManager.appendCustomEntry("subagent_meta", {
      origin: "subagent",
      agentId: opts.agentId,
      parentSession: prepared.parentPath ?? null,
      parentSessionId: opts.parentSessionId ?? null,
      model: opts.model ?? null,
      mode: opts.mode ?? "one-shot",
      label: firstLine(opts.task).slice(0, 80),
      inheritedEventCount,
      depth: opts.depth ?? 0,
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });
  } catch (e) {
    wipeSessionFile(sessionManager.getSessionFile());
    throw e;
  }

  const services = await createAgentSessionServices({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    resourceLoaderOptions: {
      extensionFactories: getConfig("PI_SYSTEM_WORKER") === "1" ? [] : await filterExtensionFactories(),
      noContextFiles: getConfig("PI_DISABLE_PROJECT_CONTEXT") === "1",
      ...(opts.systemPrompt?.trim() ? { appendSystemPrompt: [opts.systemPrompt.trim()] } : {}),
    },
  });

  const excludeTools = buildExcludeTools(prepared.childConfig, opts.depth);
  let model = undefined;
  if (opts.model?.trim()) {
    const resolved = resolveCliModel({
      cliModel: opts.model.trim(),
      modelRuntime: services.modelRuntime,
    });
    if (resolved.error || !resolved.model) {
      throw new Error(resolved.error ?? `unknown model: ${opts.model}`);
    }
    model = resolved.model;
  }

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    excludeTools,
    sessionStartEvent: { type: "session_start", cwd: opts.cwd },
  });

  const sessionPath = sessionManager.getSessionFile();
  if (!sessionPath) throw new Error("embedded sub-agent: session file not created");
  const resolvedModel = session.model;
  if (resolvedModel?.provider && resolvedModel.id) {
    sessionManager.appendModelChange(resolvedModel.provider, resolvedModel.id);
  }
  const workspace = currentWorkspaceContext()?.workspace ?? prepared.workspace;
  opts.onUpdate?.({ text: "", transcript: "", sessionPath });

  let transcript = "";
  let streamingDelta = "";
  let emitTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEmitAt = 0;
  const streamThrottleMs = Number(getConfig("SUBAGENT_STREAM_THROTTLE_MS") ?? "") || 150;

  const scheduleEmit = (): void => {
    if (!opts.onUpdate) return;
    const elapsed = Date.now() - lastEmitAt;
    const emit = (): void => {
      lastEmitAt = Date.now();
      const { output } = extractAssistantOutput(session.messages, { streamingDelta, skipPrefix: inheritedEventCount });
      opts.onUpdate!({ text: output, transcript, sessionPath });
    };
    if (elapsed >= streamThrottleMs) {
      if (emitTimer) {
        clearTimeout(emitTimer);
        emitTimer = undefined;
      }
      emit();
      return;
    }
    if (!emitTimer) {
      emitTimer = setTimeout(() => {
        emitTimer = undefined;
        emit();
      }, streamThrottleMs - elapsed);
    }
  };

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

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    const line = eventToJsonLine(event);
    if (line) transcript += line;
    streamingDelta = streamingDeltaFromEvent(event, streamingDelta);
    scheduleEmit();
    emitEmbeddedSubagentEvent(event as unknown as Record<string, unknown>, {
      sessionId: session.sessionId,
      sessionPath,
      workspace,
    });
  });

  return {
    session: session as OpenedEmbedded["session"],
    sessionManager,
    sessionPath,
    unsub,
    workspace,
    inheritedEventCount,
    getTranscript: () => transcript,
    getStreamingDelta: () => streamingDelta,
    clearEmitTimer: () => {
      if (emitTimer) clearTimeout(emitTimer);
    },
  };
}

/** Create the in-process child session. Caller owns unsub; this does not dispose. */
export async function createEmbeddedChildSession(opts: EmbeddedSubagentOpts): Promise<EmbeddedChildHandle> {
  const prepared = prepareEmbeddedConfig(opts);
  try {
    return await runInWorkspace(prepared.ctx, () => openEmbeddedChildSession(opts, prepared));
  } catch (e) {
    prepared.cleanup();
    throw e;
  }
}

export async function runEmbeddedSubagent(opts: EmbeddedSubagentOpts): Promise<EmbeddedSubagentResult> {
  const prepared = prepareEmbeddedConfig({ ...opts, mode: "one-shot" });
  let transcript = "";
  let aborted = false;

  try {
    return await runInWorkspace(prepared.ctx, async () => {
      const child = await openEmbeddedChildSession({ ...opts, mode: "one-shot" }, prepared);
      const { session, sessionPath, unsub, clearEmitTimer } = child;
      transcript = child.getTranscript();

      const idleMs = opts.timeoutMs ?? (Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "300000") || 300000);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          void session.abort();
        }, idleMs);
      };
      armIdle();

      const onAbort = (): void => {
        aborted = true;
        void session.abort();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      let result: EmbeddedSubagentResult;
      try {
        await new Promise<void>((resolve, reject) => {
          void session
            .prompt(opts.task, { source: "rpc", preflightResult: (ok) => ok && resolve() })
            .catch(reject);
        });
        await session.waitForIdle();
        const streamingDelta = child.getStreamingDelta();
        transcript = child.getTranscript();
        const { output, stopReason } = extractAssistantOutput(session.messages, {
          streamingDelta,
          aborted,
          skipPrefix: child.inheritedEventCount,
        });
        const ok = !aborted && output.trim().length > 0 && stopReason !== "error";
        result = {
          ok,
          output,
          exitCode: ok ? 0 : aborted ? -1 : 1,
          error: ok ? undefined : output.trim() ? undefined : aborted ? "aborted" : "(no output)",
          transcript,
          sessionPath,
          stopReason,
          partial: !ok && output.trim().length > 0,
        };
      } catch (e) {
        const streamingDelta = child.getStreamingDelta();
        transcript = child.getTranscript();
        const { output, stopReason } = extractAssistantOutput(session.messages, {
          streamingDelta,
          aborted,
          skipPrefix: child.inheritedEventCount,
        });
        result = {
          ok: false,
          output,
          exitCode: aborted ? -1 : 1,
          error: aborted ? "aborted" : String((e as Error)?.message ?? e),
          transcript,
          sessionPath,
          stopReason,
          partial: output.trim().length > 0,
        };
      } finally {
        unsub();
        if (idleTimer) clearTimeout(idleTimer);
        clearEmitTimer();
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          await session.abort();
        } catch {
          /* idle */
        }
        session.dispose();
      }
      return result;
    });
  } catch (e) {
    return {
      ok: false,
      output: "",
      exitCode: -1,
      error: String((e as Error)?.message ?? e),
      transcript,
      sessionPath: "",
      stopReason: aborted ? "aborted" : "error",
    };
  } finally {
    prepared.cleanup();
  }
}

function acceptPrompt(session: EmbeddedChildHandle["session"], text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void session
      .prompt(text, {
        source: "rpc",
        preflightResult: (ok) => {
          if (ok) resolve();
          else reject(new Error("embedded sub-agent: prompt not accepted"));
        },
      })
      .catch(reject);
  });
}

/** Continuable embedded spawn: install Activation, accept the first prompt, return immediately. */
export async function startContinuableEmbedded(opts: ContinuableEmbeddedOpts): Promise<ContinuableEmbeddedStart> {
  const prepared = prepareEmbeddedConfig({ ...opts, mode: "continuable" });
  let child: OpenedEmbedded | undefined;
  try {
    return await runInWorkspace(prepared.ctx, async () => {
      child = await openEmbeddedChildSession({ ...opts, mode: "continuable" }, prepared);
      const parentSessionId = opts.parentSessionId ?? "";
      try {
        installActivation({
          childId: opts.agentId,
          sessionPath: child.sessionPath,
          parentSessionId,
          parentSessionPath: opts.parentSessionPath?.trim() || "",
          workspace: child.workspace,
          session: child.session,
          sessionManager: child.sessionManager,
          announced: false,
          depth: opts.depth ?? 0,
          ...(opts.parentActivationId ? { parentActivationId: opts.parentActivationId } : {}),
          onSettled: (info) => {
            child?.unsub();
            child?.clearEmitTimer();
            prepared.cleanup();
            opts.onSettled?.(info);
          },
        });
      } catch (e) {
        child.unsub();
        child.clearEmitTimer();
        try {
          child.session.dispose();
        } catch {
          /* create-only rollback */
        }
        prepared.cleanup();
        throw e;
      }
      const text = `${opts.task}\n\n${continuableReturnGuidance(parentSessionId)}`;
      try {
        await acceptPrompt(child.session, text);
      } catch (e) {
        await disposeActivation(opts.agentId, "rollback");
        child.unsub();
        child.clearEmitTimer();
        prepared.cleanup();
        throw e;
      }
      markAnnounced(opts.agentId);
      // spec 3: establishCatalogChild after first accept
      return { agentId: opts.agentId, sessionPath: child.sessionPath };
    });
  } catch (e) {
    if (child === undefined) prepared.cleanup();
    throw e;
  }
}
