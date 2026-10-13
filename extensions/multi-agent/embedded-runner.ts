// Child sub-agent sessions: a real SessionManager + JSONL. The same runner drives both backends —
// in this process (openEmbeddedChildSession) or in a worker process over RPC (worker-session.ts).

import { type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { promptWasAccepted } from "../_shared/promptDisposition.js";
import { installToolRefreshBatching } from "../_shared/tool-refresh-batch.js";
import { sharedModelRuntime } from "../_shared/shared-model-runtime.js";
import { getConfig, withoutSensitiveProcessConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext, runInWorkspace } from "../_shared/workspace-context.js";
import { attachSessionCwd, sameDirectory, WORKING_DIRECTORY_ENTRY } from "../_shared/session-cwd.js";
import { registerChildApprovalRoute } from "../_shared/approval-route.js";
import { continuableReturnGuidance } from "./adjacent-tools.js";
import {
  disposeActivation,
  installActivation,
  markAnnounced,
  type ActivationSettledInfo,
  type AgentSessionLike,
} from "./activation.js";
import { describeUnfinishedRun, extractAssistantOutput, type SubagentStopReason } from "./assistant-output.js";
import type { SettlementNotice } from "./settlement-notice.js";
import { emitEmbeddedSubagentEvent } from "./embedded-events.js";
import { leakedErrorText, onLeakedError, reportLeakedError, runAsChild } from "../_shared/leak-owner.js";
import { abortQuietly, Teardown } from "./teardown.js";
import { guardListener } from "../_shared/guard-listener.js";
import { wipeSessionFile, withForkNote, writeSeed } from "./fork-seed.js";
import { readMaxDepth } from "./depth.js";
import { buildSubagentRuntimeConfig, type AgentResult, type AgentUpdate } from "./runner.js";
import { appendTranscriptTail, transcriptLineFromEvent } from "./transcript-tail.js";
import {
  createStructuredCapture,
  STRUCTURED_OUTPUT_TOOL,
  withStructuredInstruction,
  type StructuredCapture,
} from "./structured-output.js";

export interface EmbeddedSubagentOpts {
  /** 子会话的工作目录（父会话的当前目录）：工具与项目说明都从这里读。 */
  cwd: string;
  /** 父会话的原始目录：子会话头用它，会话目录与归属不跟着工作目录走。省略时等于 cwd。 */
  projectCwd?: string;
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
  outputSchema?: object;
  /** 子会话跑在哪：记进 subagent_meta，冷恢复时按它选后端。 */
  backend?: "in-process" | "worker";
}

export interface ContinuableEmbeddedOpts extends EmbeddedSubagentOpts {
  onSettled?: (info: ActivationSettledInfo) => void;
  /** 父会话没有登记宿主时，结算通知的退路（见 activation.ts notifyParent）。 */
  deliverFallback?: (notice: SettlementNotice) => void;
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
    appendMessage: (message: Parameters<SessionManager["appendMessage"]>[0]) => void;
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
  structured?: unknown;
}

/** 工具在跑时吐进度的间隔。要明显短于父侧卡死回收阈值 SUBAGENT_STUCK_MS（默认 300 秒）。 */
const TOOL_HEARTBEAT_MS = 60_000;
/** 流已经开始后，两个事件之间允许的最长安静。思考、文字、工具参数都会逐段推送，两分钟没动静基本是卡住了。 */
const DEFAULT_STREAM_STALL_MS = 120_000;
/** 卡住后自动中断并续跑的次数。用完还卡就按空闲超时结束。 */
const DEFAULT_STALL_RETRIES = 2;
const STALL_CHECK_MS = 5_000;

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
  "prompt-commands",
  "context-rules",
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
  "working-directory",
  "github",
  "batch-tools",
  "tts",
  "visual-companion",
]);

async function filterExtensionFactories(): Promise<InlineExtension[]> {
  const { manifestExtensions } = await import("../deferred-manifest.js");
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

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.replace(/\r$/, "").trim();
}

function streamingDeltaFromEvent(event: AgentSessionEvent, prev: string): string {
  const ev = event as Record<string, unknown>;
  const msg = ev.message as { role?: string } | undefined;
  const assistantBoundary =
    (ev.type === "message_start" || ev.type === "message_end") &&
    (!msg?.role || msg.role === "assistant");
  if (assistantBoundary) return "";
  if (ev.type !== "message_update") return prev;
  const ame = ev.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
  if (ame?.type === "text_start") return "";
  if (ame?.type === "text_delta" && typeof ame.delta === "string") return prev + ame.delta;
  return prev;
}

export type PreparedEmbedded = {
  childConfig: Record<string, string>;
  parentPath: string | undefined;
  workspace: string;
  ctx: {
    origin: "subagent";
    workspace: string;
    cwd: string;
    config: Record<string, string>;
    sessionId?: () => string | undefined;
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
  // 子代理沿用父会话身份：审批档 / 模式按父会话读，不退回项目默认。
  const parentSessionId = currentWorkspaceContext()?.sessionId;
  return {
    childConfig,
    parentPath,
    workspace,
    ctx: {
      origin: "subagent",
      workspace,
      // ALS 的 cwd 是会话的原始目录（宿主主会话也是这样）：审批档、模式按它查，不跟着 worktree 走。
      // 子会话实际干活的目录在 SDK 会话里（services cwd = opts.cwd）。
      cwd: opts.projectCwd ?? opts.cwd,
      config: childConfig,
      ...(parentSessionId ? { sessionId: parentSessionId } : {}),
    },
    cleanup: rc.cleanup,
  };
}

export type OpenedEmbedded = EmbeddedChildHandle & {
  getTranscript: () => string;
  getStreamingDelta: () => string;
  /** 把当前进度再发一次 onUpdate（注册表据此刷新 updatedAt）。 */
  heartbeat: () => void;
  clearEmitTimer: () => void;
  inheritedEventCount: number;
  structured?: StructuredCapture;
};

/** 打开子会话的方式：本进程（openEmbeddedChildSession）或 worker 进程（worker-session.ts 的代理）。 */
export type ChildSessionOpener = (opts: EmbeddedSubagentOpts, prepared: PreparedEmbedded) => Promise<OpenedEmbedded>;

/** 在本进程里建子会话；worker 进程里的 worker-host.ts 也用它。 */
export async function openEmbeddedChildSession(opts: EmbeddedSubagentOpts, prepared: PreparedEmbedded): Promise<OpenedEmbedded> {
  const sessionManager = SessionManager.create(opts.projectCwd ?? opts.cwd, undefined, {
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
      backend: opts.backend ?? "in-process",
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });
    // 父会话切过工作目录：子会话头仍是原始目录，当前目录记成一条 working_directory，冷恢复时据此切回。
    if (opts.projectCwd && !sameDirectory(opts.projectCwd, opts.cwd)) {
      sessionManager.appendCustomEntry(WORKING_DIRECTORY_ENTRY, { cwd: opts.cwd });
    }
  } catch (e) {
    wipeSessionFile(sessionManager.getSessionFile());
    throw e;
  }

  const structured = opts.outputSchema ? createStructuredCapture(opts.outputSchema) : undefined;
  const baseFactories = getConfig("PI_SYSTEM_WORKER") === "1" ? [] : await filterExtensionFactories();
  const extensionFactories = structured ? [...baseFactories, structured.factory] : baseFactories;
  const systemPrompt = structured ? withStructuredInstruction(opts.systemPrompt) : opts.systemPrompt?.trim();

  const modelRuntime = sharedModelRuntime();
  const services = await createAgentSessionServices({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    // 复用宿主的 ModelRuntime：每个子会话各建一份是并行冷启动的大头之一
    ...(modelRuntime ? { modelRuntime } : {}),
    resourceLoaderOptions: {
      extensionFactories,
      noContextFiles: getConfig("PI_DISABLE_PROJECT_CONTEXT") === "1",
      ...(systemPrompt ? { appendSystemPrompt: [systemPrompt] } : {}),
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
    ...(opts.tools?.length
      ? {
          tools: opts.outputSchema
            ? [...new Set([...opts.tools, STRUCTURED_OUTPUT_TOOL])]
            : opts.tools,
        }
      : {}),
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    excludeTools,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });
  // 子会话也加载 MCP 扩展；绑定扩展前装上，首次投影的一批工具只刷新一次工具表。
  installToolRefreshBatching(session);
  // 子代理自己也能 working_directory / create_worktree，只换它自己的目录。
  const detachCwd = attachSessionCwd(session);

  const sessionPath = sessionManager.getSessionFile();
  if (!sessionPath) throw new Error("embedded sub-agent: session file not created");
  const resolvedModel = session.model;
  if (resolvedModel?.provider && resolvedModel.id) {
    sessionManager.appendModelChange(resolvedModel.provider, resolvedModel.id);
  }
  const workspace = currentWorkspaceContext()?.workspace ?? prepared.workspace;
  // 子会话真实生效的档位（已按模型能力收窄），不是调用参数里请求的那个。
  const runningThinkingLevel: string | undefined = session.thinkingLevel;
  // 进度回调（spawn_agent 记注册表、推给父会话）出错不能打断子代理：它在子会话的监听方里、或节流定时器里被调，
  // 抛出去要么让子代理这次工具调用 / 这一轮失败，要么成了漏网错误（_shared/guard-listener.ts）。吞掉、记日志，后面的进度照常推。
  const deliverProgress = guardListener(`sub-agent ${opts.agentId} progress`, (build: () => AgentUpdate) => {
    if (opts.onUpdate) opts.onUpdate(build());
  });
  deliverProgress(() => ({ text: "", transcript: "", sessionPath, thinkingLevel: runningThinkingLevel }));

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
      deliverProgress(() => {
        const { output } = extractAssistantOutput(session.messages, { streamingDelta, skipPrefix: inheritedEventCount });
        return { text: output, transcript, sessionPath, thinkingLevel: session.thinkingLevel };
      });
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

  // Named-agent `--tools` is an allowlist. SDK `tools` covers builtins; extension
  // tools (MCP, spawn_agent, …) stay registered unless the session can hide them.
  const allow = opts.tools?.map((t) => t.trim()).filter(Boolean) ?? [];
  const setActive = (session as { setActiveTools?: (names: string[]) => void }).setActiveTools;
  if (allow.length && typeof setActive === "function") {
    setActive([...new Set(allow)]);
  }

  // 监听方出错不能抛回 SDK（_shared/guard-listener.ts）。
  const onEvent = guardListener(`sub-agent ${opts.agentId} events`, (event: AgentSessionEvent) => {
    // 原始事件仍交给界面；这里只留剥掉快照后的 64KB 尾部，避免 partial 按输出长度平方留在堆上。
    transcript = appendTranscriptTail(transcript, transcriptLineFromEvent(event));
    streamingDelta = streamingDeltaFromEvent(event, streamingDelta);
    scheduleEmit();
    emitEmbeddedSubagentEvent(event as unknown as Record<string, unknown>, {
      sessionId: session.sessionId,
      sessionPath,
      workspace,
    });
  });
  const unsubEvents = session.subscribe(onEvent);

  // 子会话需要人批准时经父会话问（approval-route.ts）。可续聊的由 Activation 再登记一份，管到结算为止。
  const detachApproval = registerChildApprovalRoute({
    sessionPath,
    parentSessionPath: prepared.parentPath,
    agentId: opts.agentId,
    label: firstLine(opts.task).slice(0, 80),
  });

  const unsub = () => {
    unsubEvents();
    detachCwd();
    detachApproval();
    onEvent.report();
    deliverProgress.report();
  };

  return {
    session: session as OpenedEmbedded["session"],
    sessionManager,
    sessionPath,
    unsub,
    workspace,
    inheritedEventCount,
    structured,
    getTranscript: () => transcript,
    getStreamingDelta: () => streamingDelta,
    heartbeat: scheduleEmit,
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

export async function runEmbeddedSubagent(
  opts: EmbeddedSubagentOpts,
  open: ChildSessionOpener = openEmbeddedChildSession,
): Promise<EmbeddedSubagentResult> {
  const prepared = prepareEmbeddedConfig({ ...opts, mode: "one-shot" });
  let transcript = "";
  let aborted = false;
  /** 这次运行里漏出来的错误（_shared/leak-owner.ts）：中断运行，按 error 结算。 */
  let leaked: string | undefined;
  let liveSession: { abort: () => unknown } | undefined;
  // 建会话之前就登记：扩展初始化时漏出来的也算这次运行的。
  const offLeak = onLeakedError(opts.agentId, (error) => {
    if (leaked) return;
    leaked = leakedErrorText(error);
    if (liveSession) abortQuietly(liveSession);
  });

  try {
    return await runAsChild(opts.agentId, () => runInWorkspace(prepared.ctx, async () => {
      const child = await open({ ...opts, mode: "one-shot" }, prepared);
      const { session, sessionPath, unsub, clearEmitTimer } = child;
      liveSession = session;
      transcript = child.getTranscript();

      // 空闲超时只管「卡死」：子会话每来一个事件就算有活动，计时从头算。原先只在开头 arm 一次，
      // 等于 5 分钟硬杀，干活中的子代理一到点就被 abort。和进程子代理（runner.ts）同一套口径：
      // 首个模型输出前用更长的启动宽限，另有 idle×10 的硬上限兜住一直滴答输出的情况。
      const idleMs = opts.timeoutMs ?? (Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "300000") || 300000);
      const startupMs = Number(getConfig("SUBAGENT_STARTUP_MS") ?? "") || Math.max(idleMs * 2, 300_000);
      const maxMs = Number(getConfig("SUBAGENT_MAX_MS") ?? "") || idleMs * 10;
      let timedOut: string | undefined;
      let sawOutput = false;
      let lastActivity = Date.now();
      const expire = (reason: string): void => {
        if (aborted) return;
        timedOut = reason;
        aborted = true;
        abortQuietly(session);
      };
      // 在跑的工具（含嵌套调用）。工具有自己的 timeout，安静不等于卡死：`cargo build *> log` 这类命令
      // 整段没有输出，跑 6 分钟就会被当成空闲杀掉。工具在跑时空闲计时不到期，硬上限照管。
      const toolsInFlight = new Set<string>();
      // 上游卡住：模型请求在途（turn_start 到 assistant 的 message_end）却长时间没有任何流事件。
      // 不整段杀掉子代理，只中断这一次请求，再补一句继续；被中断的半条回复不会发给模型，
      // 它从最后一个有效状态接着跑。连续卡住超过次数才按空闲超时结束。
      const stallMs = configMs("SUBAGENT_STREAM_STALL_MS", DEFAULT_STREAM_STALL_MS);
      const firstTokenMs = configMs("SUBAGENT_FIRST_TOKEN_MS", idleMs);
      const maxStallCuts = configCount("SUBAGENT_STALL_RETRIES", DEFAULT_STALL_RETRIES);
      let awaitingModel = false;
      let streamStarted = false;
      let lastModelEventAt = Date.now();
      let stallCuts = 0;
      /** 刚中断的那次请求安静了多久；waitForIdle 返回后据此续跑。 */
      let stallCutSilentMs: number | undefined;
      const stallTimer = setInterval(() => {
        if (!awaitingModel || stallCutSilentMs !== undefined || aborted || toolsInFlight.size > 0) return;
        const silentMs = Date.now() - lastModelEventAt;
        if (silentMs < (streamStarted ? stallMs : firstTokenMs)) return;
        if (stallCuts >= maxStallCuts) {
          expire(
            `idle timeout: upstream sent nothing for ${Math.round(silentMs / 1000)}s` +
              (stallCuts > 0 ? ` (after ${stallCuts} automatic ${stallCuts === 1 ? "retry" : "retries"})` : ""),
          );
          return;
        }
        stallCuts += 1;
        stallCutSilentMs = silentMs;
        awaitingModel = false;
        abortQuietly(session);
      }, STALL_CHECK_MS);
      stallTimer.unref?.();
      // 每个事件只记时间戳，不重建定时器：流式 delta 很密，到点时再按最后一次活动顺延。
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = (delay: number): void => {
        idleTimer = setTimeout(() => {
          const limit = sawOutput ? idleMs : startupMs;
          // 工具在跑归工具自己的 timeout，等模型归上面的卡顿看门狗。
          if (toolsInFlight.size > 0 || awaitingModel || stallCutSilentMs !== undefined) return armIdle(limit);
          const left = lastActivity + limit - Date.now();
          if (left > 0) return armIdle(left);
          expire(
            sawOutput
              ? `idle timeout: no activity for ${Math.round(idleMs / 1000)}s`
              : `startup timeout: no output for ${Math.round(startupMs / 1000)}s`,
          );
        }, delay);
      };
      armIdle(startupMs);
      const hardTimer = setTimeout(() => expire(`hard timeout after ${Math.round(maxMs / 1000)}s`), maxMs);
      // 工具安静跑的时候没有事件，onUpdate 不触发，注册表 updatedAt 不动，父侧 reapStuck 会把它当卡死回收。
      // 工具在跑就定时吐一次进度。
      const heartbeatTimer = setInterval(() => {
        if (toolsInFlight.size > 0 || awaitingModel) child.heartbeat();
      }, TOOL_HEARTBEAT_MS);
      heartbeatTimer.unref?.();
      // 监听方出错不能抛回 SDK（_shared/guard-listener.ts）。
      const onActivity = guardListener(`sub-agent ${opts.agentId} activity watch`, (event: AgentSessionEvent) => {
        lastActivity = Date.now();
        const type = (event as { type?: string }).type;
        const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
        if (typeof toolCallId === "string") {
          if (type === "tool_execution_start") toolsInFlight.add(toolCallId);
          else if (type === "tool_execution_end") toolsInFlight.delete(toolCallId);
        }
        if (type === "turn_start") {
          awaitingModel = true;
          streamStarted = false;
          lastModelEventAt = lastActivity;
        } else if (type === "message_update") {
          streamStarted = true;
          lastModelEventAt = lastActivity;
        } else if (
          (type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") ||
          type === "agent_end" ||
          type === "compaction_start"
        ) {
          awaitingModel = false;
        }
        if (!sawOutput && (type === "message_update" || type === "tool_execution_start" || type === "tool_execution_update")) {
          // 启动宽限结束：换成常规空闲窗口重新计时，否则要等整段宽限过完才开始查空闲。
          sawOutput = true;
          if (idleTimer) clearTimeout(idleTimer);
          armIdle(idleMs);
        }
      });
      const unsubActivity = session.subscribe(onActivity);

      const onAbort = (): void => {
        aborted = true;
        abortQuietly(session);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      let result: EmbeddedSubagentResult;
      try {
        // 建会话时就漏了错：不再开跑，直接按 error 结束。
        if (!leaked) {
          await acceptPrompt(session, withForkNote(opts.task, child.inheritedEventCount));
          // preflight 期间到的错误：那时的中断会被起跑重置，跑起来了再中断一次。
          if (leaked) abortQuietly(session);
          await session.waitForIdle();
        }
        // 卡顿看门狗刚中断了一次请求：子会话停在那条被中断的 assistant 上，补一句继续接着跑。
        // 中断和回复恰好同时完成时最后一条不是 aborted，不续。
        while (stallCutSilentMs !== undefined && !aborted && !leaked) {
          const silentMs = stallCutSilentMs;
          stallCutSilentMs = undefined;
          if (!endedOnAbortedReply(session.messages as Parameters<typeof endedOnAbortedReply>[0])) break;
          lastActivity = Date.now();
          await acceptPrompt(session, stallContinuePrompt(silentMs));
          await session.waitForIdle();
        }
        const streamingDelta = child.getStreamingDelta();
        transcript = child.getTranscript();
        const { output, stopReason } = extractAssistantOutput(
          session.messages as Parameters<typeof extractAssistantOutput>[0],
          { streamingDelta, aborted, skipPrefix: child.inheritedEventCount },
        );
        // 漏网错误中断的：按出错结算，不算用户停下的。
        const interrupted = !leaked && (aborted || stopReason === "aborted");
        const ok = !leaked && !interrupted && stopReason === "completed" && output.trim().length > 0;
        // 没有最终答复时把停下的原因交给父代理（模型报错原文 / 停在哪个工具上），而不是光秃秃的 "(no output)"。
        const unfinished = ok || interrupted || leaked
          ? undefined
          : describeUnfinishedRun(session.messages as Parameters<typeof describeUnfinishedRun>[0], child.inheritedEventCount);
        result = {
          ok,
          output,
          exitCode: ok ? 0 : interrupted ? -1 : 1,
          error: ok
            ? undefined
            : leaked
              ? leaked
              : interrupted
                ? (timedOut ?? "aborted")
                : (unfinished ?? (output.trim() ? undefined : "(no output)")),
          transcript,
          sessionPath,
          stopReason: leaked ? "error" : stopReason,
          partial: !ok && output.trim().length > 0,
          ...(child.structured?.captured() ? { structured: child.structured.captured()!.value } : {}),
        };
      } catch (e) {
        const streamingDelta = child.getStreamingDelta();
        transcript = child.getTranscript();
        const { output, stopReason } = extractAssistantOutput(
          session.messages as Parameters<typeof extractAssistantOutput>[0],
          { streamingDelta, aborted, skipPrefix: child.inheritedEventCount },
        );
        result = {
          ok: false,
          output,
          exitCode: aborted && !leaked ? -1 : 1,
          error: leaked ?? (aborted ? (timedOut ?? "aborted") : String((e as Error)?.message ?? e)),
          transcript,
          sessionPath,
          stopReason: leaked ? "error" : stopReason,
          partial: output.trim().length > 0,
          ...(child.structured?.captured() ? { structured: child.structured.captured()!.value } : {}),
        };
      } finally {
        // 释放边界逐步收尾：哪一步抛错都不能把上面算好的结果换成一条错误（teardown.ts）。
        const teardown = new Teardown(opts.agentId);
        teardown.step("stop leak attribution", offLeak);
        teardown.step("stop event forwarding", unsub);
        teardown.step("stop activity watch", unsubActivity);
        onActivity.report();
        teardown.step("clear timers", () => {
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(hardTimer);
          clearInterval(heartbeatTimer);
          clearInterval(stallTimer);
        });
        teardown.step("clear emit timer", clearEmitTimer);
        teardown.step("detach abort signal", () => opts.signal?.removeEventListener("abort", onAbort));
        try {
          await session.abort();
        } catch {
          /* idle */
        }
        teardown.step("dispose session", () => session.dispose());
        teardown.report();
      }
      return result;
    }));
  } catch (e) {
    return {
      ok: false,
      output: "",
      exitCode: -1,
      error: leaked ?? String((e as Error)?.message ?? e),
      transcript,
      sessionPath: "",
      stopReason: aborted && !leaked ? "aborted" : "error",
    };
  } finally {
    const teardown = new Teardown(opts.agentId);
    // 建会话就失败时上面的收尾没走到；重复撤是空操作。
    teardown.step("stop leak attribution", offLeak);
    teardown.step("remove derived config", prepared.cleanup);
    teardown.report();
  }
}

function configMs(key: string, fallback: number): number {
  const n = Number(getConfig(key)?.trim() || "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 非负整数配置；`0` 是合法值（关掉自动续跑），不能用 `||` 回退。 */
function configCount(key: string, fallback: number): number {
  const raw = getConfig(key)?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function endedOnAbortedReply(messages: Array<{ role?: string; stopReason?: string }>): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && last.stopReason === "aborted";
}

export function stallContinuePrompt(silentMs: number): string {
  return (
    `（自动续跑）上游模型 ${Math.round(silentMs / 1000)} 秒没有任何响应，上一次请求已在本地中断。` +
    "请从中断前的状态继续完成原任务，已经完成的步骤不要重做。"
  );
}

function acceptPrompt(session: EmbeddedChildHandle["session"], text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let accepted = false;
    void session
      .prompt(text, {
        source: "rpc",
        preflightResult: (disposition) => {
          if (!promptWasAccepted(disposition)) return;
          accepted = true;
          resolve();
        },
      })
      .then(() => {
        if (!accepted) reject(new Error("embedded sub-agent: prompt not accepted"));
      })
      .catch((error) => {
        if (!accepted) reject(error);
      });
  });
}

/** Continuable embedded spawn: install Activation, accept the first prompt, return immediately. */
export async function startContinuableEmbedded(
  opts: ContinuableEmbeddedOpts,
  open: ChildSessionOpener = openEmbeddedChildSession,
): Promise<ContinuableEmbeddedStart> {
  const prepared = prepareEmbeddedConfig({ ...opts, mode: "continuable" });
  let child: OpenedEmbedded | undefined;
  // 收尾的几步逐个做，一步出错不挡后面的（teardown.ts）。
  const release = (opened: OpenedEmbedded, dispose: boolean): Teardown => {
    const teardown = new Teardown(opts.agentId);
    teardown.step("stop event forwarding", opened.unsub);
    teardown.step("clear emit timer", opened.clearEmitTimer);
    if (dispose) teardown.step("dispose session", () => opened.session.dispose());
    teardown.step("remove derived config", prepared.cleanup);
    return teardown;
  };
  // 建会话之前就登记：扩展初始化时漏出来的错误先记着，装上 Activation（它登记自己的处理器）后交给它。
  let earlyLeak: { error: unknown } | undefined;
  const offEarly = onLeakedError(opts.agentId, (error) => {
    earlyLeak ??= { error };
  });
  try {
    return await runAsChild(opts.agentId, () => runInWorkspace(prepared.ctx, async () => {
      child = await open({ ...opts, mode: "continuable" }, prepared);
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
          ...(opts.deliverFallback ? { deliverFallback: opts.deliverFallback } : {}),
          // 进程内的会话结算后留在驻留池；worker 会话结算即退出，不占 worker 名额。
          keepResident: open === openEmbeddedChildSession,
          onSettled: (info) => {
            // 记账（注册表、名额）放在最后一步，前面哪一步出错都要走到。
            const teardown = child ? release(child, false) : new Teardown(opts.agentId);
            teardown.step("record result", () => opts.onSettled?.(info));
            teardown.report();
          },
        });
      } catch (e) {
        release(child, true).report();
        throw e;
      }
      // Activation 已经接管归属；之前记下的交给它（它会在第一轮跑起来后中断、按 error 结算）。
      offEarly();
      if (earlyLeak) reportLeakedError(earlyLeak.error, opts.agentId);
      const text = `${withForkNote(opts.task, child.inheritedEventCount)}\n\n${continuableReturnGuidance(parentSessionId)}`;
      try {
        await acceptPrompt(child.session, text);
      } catch (e) {
        try {
          await disposeActivation(opts.agentId, "rollback");
        } catch (rollbackError) {
          console.error(`[multi-agent] sub-agent ${opts.agentId}: rollback failed`, rollbackError);
        }
        release(child, false).report();
        throw e;
      }
      markAnnounced(opts.agentId);
      // spec 3: establishCatalogChild after first accept
      return { agentId: opts.agentId, sessionPath: child.sessionPath };
    }));
  } catch (e) {
    if (child === undefined) {
      const teardown = new Teardown(opts.agentId);
      teardown.step("remove derived config", prepared.cleanup);
      teardown.report();
    }
    throw e;
  } finally {
    // 启动失败的路径上没走到上面的撤销；重复撤是空操作。
    offEarly();
  }
}
