// In-process one-shot sub-agent: real SessionManager + JSONL in the Electron sidecar.
// High-risk profiles (worktree) and non-Electron hosts fall back to spawnPiAgent in index.ts.

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getConfig, withoutSensitiveProcessConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext, runInWorkspace } from "../_shared/workspace-context.js";
import { extractAssistantOutput, type SubagentStopReason } from "./assistant-output.js";
import { type CapabilityProfile } from "./capability.js";
import { emitEmbeddedSubagentEvent } from "./embedded-events.js";
import { buildSubagentRuntimeConfig, type AgentResult, type AgentUpdate } from "./runner.js";

export interface EmbeddedSubagentOpts {
  cwd: string;
  task: string;
  agentId: string;
  parentSessionPath?: string;
  model?: string;
  systemPrompt?: string;
  /** Named-agent tool allowlist (--tools). */
  tools?: string[];
  env?: Record<string, string>;
  mcp?: boolean | string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (update: AgentUpdate) => void;
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
  "multi-agent",
  "github",
  "batch-tools",
  "tts",
  "visual-companion",
]);

async function filterExtensionFactories(): Promise<Array<(...args: never[]) => unknown>> {
  const { manifestExtensions } = await import("../../index.js");
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

function buildExcludeTools(env: Record<string, string>): string[] {
  const deny = new Set(["spawn_agent", "explore_context"]);
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

export async function runEmbeddedSubagent(opts: EmbeddedSubagentOpts): Promise<EmbeddedSubagentResult> {
  const rc = buildSubagentRuntimeConfig(opts.mcp, opts.env ?? {});
  const als = currentWorkspaceContext()?.config ?? {};
  const childConfig = withoutSensitiveProcessConfig({
    ...als,
    ...rc.env,
    ...(rc.path ? { PI_RUNTIME_CONFIG: rc.path } : {}),
  });
  const parentPath = opts.parentSessionPath?.trim() || undefined;

  let transcript = "";
  let streamingDelta = "";
  let aborted = false;

  try {
    return await runInWorkspace(
      {
        origin: "subagent",
        workspace: currentWorkspaceContext()?.workspace ?? opts.cwd,
        cwd: opts.cwd,
        config: childConfig,
      },
      async () => {
        const sessionManager = SessionManager.create(opts.cwd, undefined, {
          id: opts.agentId,
          ...(parentPath ? { parentSession: parentPath } : {}),
        });
        sessionManager.appendCustomEntry("subagent_meta", {
          origin: "subagent",
          agentId: opts.agentId,
          parentSession: parentPath ?? null,
          model: opts.model ?? null,
        });

        const services = await createAgentSessionServices({
          cwd: opts.cwd,
          agentDir: getAgentDir(),
          resourceLoaderOptions: {
            extensionFactories: getConfig("PI_SYSTEM_WORKER") === "1" ? [] : await filterExtensionFactories(),
            noContextFiles: getConfig("PI_DISABLE_PROJECT_CONTEXT") === "1",
            ...(opts.systemPrompt?.trim() ? { appendSystemPrompt: [opts.systemPrompt.trim()] } : {}),
          },
        });

        const excludeTools = buildExcludeTools(childConfig);
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
          excludeTools,
          sessionStartEvent: { type: "session_start", cwd: opts.cwd },
        });

        const sessionPath = sessionManager.getSessionFile();
        if (!sessionPath) throw new Error("embedded sub-agent: session file not created");
        const resolvedModel = session.model;
        if (resolvedModel?.provider && resolvedModel.id) {
          sessionManager.appendModelChange(resolvedModel.provider, resolvedModel.id);
        }
        const workspace = currentWorkspaceContext()?.workspace ?? opts.cwd;
        opts.onUpdate?.({ text: "", transcript: "", sessionPath });

        let emitTimer: ReturnType<typeof setTimeout> | undefined;
        let lastEmitAt = 0;
        const streamThrottleMs = Number(getConfig("SUBAGENT_STREAM_THROTTLE_MS") ?? "") || 150;

        const scheduleEmit = (): void => {
          if (!opts.onUpdate) return;
          const elapsed = Date.now() - lastEmitAt;
          const emit = (): void => {
            lastEmitAt = Date.now();
            const { output } = extractAssistantOutput(session.messages, { streamingDelta, aborted });
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
          const { output, stopReason } = extractAssistantOutput(session.messages, { streamingDelta, aborted });
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
          const { output, stopReason } = extractAssistantOutput(session.messages, { streamingDelta, aborted });
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
          if (emitTimer) clearTimeout(emitTimer);
          opts.signal?.removeEventListener("abort", onAbort);
          try {
            await session.abort();
          } catch {
            /* idle */
          }
          session.dispose();
        }
        return result;
      },
    );
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
    rc.cleanup();
  }
}
