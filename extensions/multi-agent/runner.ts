// Spawn isolated pi sub-agents (separate processes) and collect their output.
// Mirrors the official subagent example: `pi --mode json -p --no-session <task>`.

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfig, withoutSensitiveProcessConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { resolveMcpServers } from "./capability.js";
import { readMaxDepth } from "./depth.js";
import { killProcessTree, registerSubagentProcess } from "./subagentProcessRegistry.js";
import { appendTranscriptTail, slimTranscriptJsonLine } from "./transcript-tail.js";

export interface AgentResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
  /** Killed by idle/hard timeout but had already produced real output — caller should keep it. */
  partial?: boolean;
  /** 剥掉快照后的 JSONL 尾部，上限 LIVE_TRANSCRIPT_TAIL。完整历史不留在这条字符串里。 */
  transcript: string;
}

/** Streaming update payload: latest final text plus the capped JSONL tail. */
export interface AgentUpdate {
  text: string;
  transcript: string;
  /** Set by embedded runner once the child session file exists. */
  sessionPath?: string;
}

const timeoutMs = () => Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "300000") || 300000;

/** User-configured sub-agent model. Mode `inherit` forces the main-agent default; otherwise use `SUBAGENT_MODEL` (empty → inherit). */
export function resolveSubagentModel(): string | undefined {
  if (getConfig("SUBAGENT_MODE")?.trim() === "inherit") return undefined;
  const raw = getConfig("SUBAGENT_MODEL")?.trim();
  return raw || undefined;
}

/** Format the parent agent's current model as `provider/id` for `--model`. */
export function parentModelSpec(model: { provider?: string; id?: string } | null | undefined): string | undefined {
  const provider = model?.provider?.trim();
  const id = model?.id?.trim();
  if (!provider || !id) return undefined;
  return `${provider}/${id}`;
}

export function assistantTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p && typeof p === "object" && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

export function resolvePiCommand(): { cmd: string; baseArgs: string[] } {
  const entry = process.env.PI_WORKER_ENTRY?.trim();
  if (!entry) {
    throw new Error("PI_WORKER_ENTRY is not set; the Electron host must assign the worker entry at startup");
  }
  return { cmd: process.execPath, baseArgs: [entry] };
}

export function buildSubagentSkillArgs(root: string | undefined): string[] {
  const managedRoot = root?.trim();
  return managedRoot ? ["--skill", managedRoot] : [];
}

/**
 * 从子代理 `--mode json` JSONL 抽出最后一轮助手正文。
 *
 * pi 流式 `message_update` 经 toJsonEvent 后不再带 message 快照，正文只在
 * `assistantMessageEvent.text_delta` 里；`message_end` 的 content 也可能是空数组。
 * 旧实现只读 assistant.content，读不到就退回 raw JSONL 尾部——session 头会被当成
 * 「产出」交给主代理，并让 quiet-complete 在 60s 后误判成功。
 */
export interface TextExtractState {
  lastText: string;
  currentDelta: string;
}

export function createTextExtractState(): TextExtractState {
  return { lastText: "", currentDelta: "" };
}

export function extractedText(state: TextExtractState): string {
  return state.lastText || state.currentDelta;
}

/** 吸收一行原始 JSONL（含快照）。调用方随后丢掉该行，只把剥过的行放进尾部缓冲。 */
export function absorbJsonlLine(state: TextExtractState, line: string): void {
  if (!line.trim()) return;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const msg = (ev.message && typeof ev.message === "object" ? ev.message : undefined) as
    | { role?: string; content?: unknown }
    | undefined;
  const role = msg?.role ?? (typeof ev.role === "string" ? ev.role : undefined);

  if (ev.type === "message_start" && role === "assistant") {
    state.currentDelta = "";
  }

  const ame = ev.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
  if (ev.type === "message_update" && ame?.type === "text_delta" && typeof ame.delta === "string") {
    state.currentDelta += ame.delta;
  }

  const snap = role === "assistant" ? assistantTextFromContent(msg?.content ?? ev.content ?? ev.text) : "";
  if (snap) {
    state.lastText = snap;
    state.currentDelta = "";
  }

  if (ev.type === "message_end" && (role === "assistant" || !role)) {
    const endSnap = assistantTextFromContent(msg?.content);
    state.lastText = endSnap || state.currentDelta || state.lastText;
    state.currentDelta = "";
  }
}

export function extractFinalText(jsonlOutput: string): string {
  if (!jsonlOutput) return "";
  const state = createTextExtractState();
  for (const line of jsonlOutput.split(/\r?\n/)) absorbJsonlLine(state, line);
  return extractedText(state);
}

/**
 * 判断一行 `--mode json` 输出是否为 agent_end 事件（子代理逻辑完成的权威标志）。
 * 必须逐行 JSON 解析判断 type，而不是对整段 stdout 跑 `/agent_end/` 正则：后者既会被任务文本/
 * 工具结果里出现的 "agent_end" 字样误判，又会在累计 buffer 上呈 O(n²)。半行/非 JSON 一律视为否。
 */
export function isAgentEndLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const ev = JSON.parse(trimmed) as { type?: string };
    return ev?.type === "agent_end";
  } catch {
    return false;
  }
}

// Memory/KB switches a sub-agent forces OFF relative to the main agent: re-running
// embeddings / extraction in every one-shot child is wasteful and can recurse.
// MCP is handled separately (resolveMcpServers) because it's on-demand per profile.
const SUBAGENT_MEMORY_OFF: Record<string, string> = {
  MEMORY_EXTRACT: "0",
  MEMORY_AUTO_INJECT: "0",
  MEMORY_AUTO_CAPTURE: "0",
  KB_AUTO_INJECT: "0",
};

interface SubagentRuntimeConfig {
  /** Path to the derived config file, or undefined when there is no parent config file. */
  path: string | undefined;
  /** Env overrides to inject into the child (profile env + memory-off + MCP_SERVERS). */
  env: Record<string, string>;
  cleanup: () => void;
}

// getConfig reads PI_RUNTIME_CONFIG (a file) first and process.env only as a
// fallback, so a spawn-time env override can't turn off a key already present in
// that file (e.g. GUI-written MCP_SERVERS). To make sub-agent overrides actually
// win, we derive a child config: inherit every parent setting, then layer on the
// profile env, the memory-off switches, and the on-demand MCP_SERVERS. The same
// overrides are returned as `env` so they still apply when there is no parent
// config file. `mcp` (from profile.mcp) decides how much of the parent's MCP the
// sub-agent inherits (none / all / allowlist) — see resolveMcpServers.
export function buildSubagentRuntimeConfig(
  mcp: boolean | string[] | undefined,
  extraEnv: Record<string, string> = {},
): SubagentRuntimeConfig {
  const src = process.env.PI_RUNTIME_CONFIG;
  let base: Record<string, unknown> = {};
  if (src) {
    try {
      const parsed = JSON.parse(readFileSync(src, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") base = parsed as Record<string, unknown>;
    } catch {
      /* unreadable parent config: fall back to overrides only */
    }
  }
  const parentMcp = typeof base.MCP_SERVERS === "string" ? (base.MCP_SERVERS as string) : process.env.MCP_SERVERS;
  // 子级深度到顶才把 spawn_agent 并入 SAFETY_DENY_TOOLS（safety 扩展按工具名硬拦）；
  // 未到顶允许再委派。经派生 runtime-config 落盘，不只依赖 env 单链传递。
  // 保留 extraEnv（profile）已有的 deny 列表。
  const denyTools = new Set(
    (extraEnv.SAFETY_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  // 子级深度到顶才藏掉 spawn_agent；未到顶允许再委派（第七期）。
  const depth = Number(extraEnv.SUBAGENT_DEPTH ?? "");
  if (Number.isSafeInteger(depth) && depth >= readMaxDepth()) denyTools.add("spawn_agent");
  // 探索子代理也禁止再发起探索（与 spawn_agent 同款防递归）。
  denyTools.add("explore_context");
  const env = withoutSensitiveProcessConfig({
    ...extraEnv,
    ...SUBAGENT_MEMORY_OFF,
    SAFETY_DENY_TOOLS: Array.from(denyTools).join(","),
    MCP_SERVERS: resolveMcpServers(mcp, parentMcp),
  });
  if (!src) return { path: undefined, env, cleanup: () => {} };
  const merged = { ...withoutSensitiveProcessConfig(base), ...env };
  const path = join(tmpdir(), `pi-subagent-rc-${randomBytes(4).toString("hex")}.json`);
  try {
    // 0o600：派生配置全量继承父 runtime-config（含 MCP_SERVERS 等可能带 token 的字段），
    // 落到共享 tmpdir 时限制为仅本用户可读，避免多用户机（Linux /tmp）上被同机其他用户读取。
    writeFileSync(path, JSON.stringify(merged), { encoding: "utf8", mode: 0o600 });
  } catch {
    return { path: undefined, env, cleanup: () => {} };
  }
  return {
    path,
    env,
    cleanup: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        /* already gone / locked: nothing to do */
      }
    },
  };
}

type SpawnPiAgentOpts = {
  model?: string;
  signal?: AbortSignal;
  onUpdate?: (update: AgentUpdate) => void;
  env?: Record<string, string>;
  timeoutMs?: number;
  mcp?: boolean | string[];
  /** Named-agent system prompt → written to a temp file and passed via --append-system-prompt. */
  systemPrompt?: string;
  /** Named-agent tool allowlist → passed via --tools. */
  tools?: string[];
  /** Sub-agent thinking level → passed via --thinking. */
  thinkingLevel?: string;
  depth?: number;
  outputSchema?: object;
};

export function buildSubagentLaunch(
  cwd: string,
  task: string,
  opts: SpawnPiAgentOpts = {},
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  spawnOptions: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; detached?: boolean };
  cleanup: () => void;
} {
  if (opts.outputSchema) throw new Error("outputSchema 需要 Electron 进程内子会话");
  const { cmd, baseArgs } = resolvePiCommand();
  // --no-approve: sub-agents are isolated one-shot runs that must NOT load
  // project-local .pi resources (extensions / MCP / skills / SYSTEM.md). Pinning
  // it keeps them lightweight and deterministic regardless of the user's global
  // defaultProjectTrust — an "always" setting would otherwise make every
  // sub-agent re-load project-local MCP, re-creating the cold-start stampede.
  const args = [
    ...baseArgs,
    ...buildSubagentSkillArgs(getConfig("SUBAGENT_SKILLS_ROOT")),
    ...(opts.thinkingLevel ? ["--thinking", opts.thinkingLevel] : []),
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
  ];
  const model = opts.model ?? resolveSubagentModel();
  if (model) args.push("--model", model);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  let promptFile: string | undefined;
  if (opts.systemPrompt?.trim()) {
    promptFile = join(tmpdir(), `pi-subagent-sp-${randomBytes(4).toString("hex")}.md`);
    try {
      writeFileSync(promptFile, opts.systemPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptFile);
    } catch {
      promptFile = undefined;
    }
  }
  args.push(task);

  const rc = buildSubagentRuntimeConfig(opts.mcp, opts.env);
  const als = currentWorkspaceContext()?.config ?? {};
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...als,
    ...rc.env,
    ...(rc.path ? { PI_RUNTIME_CONFIG: rc.path } : {}),
    NODE_NO_WARNINGS: "1",
    ELECTRON_RUN_AS_NODE: "1",
    PI_IS_SUBAGENT: "1",
  };
  const cleanup = (): void => {
    rc.cleanup();
    if (promptFile) {
      try { rmSync(promptFile, { force: true }); } catch { /* gone */ }
    }
  };
  return {
    command: cmd,
    args,
    env,
    spawnOptions: {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform !== "win32" ? { detached: true } : {}),
    },
    cleanup,
  };
}

export async function spawnPiAgent(
  cwd: string,
  task: string,
  opts: SpawnPiAgentOpts = {},
): Promise<AgentResult> {
  const launch = buildSubagentLaunch(cwd, task, opts);

  return new Promise<AgentResult>((resolve) => {
    let settled = false;
    let sawOutput = false; // 是否已收到子进程首个 stdout 字节（用于首字节/启动宽限）
    let inTool = false; // 是否在工具执行中（tool_execution_start..end 之间）：quiet 完成兜底据此防误判
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let postExitTimer: ReturnType<typeof setTimeout> | undefined;
    // 流式 onUpdate 节流：子代理 `--mode json` 的每个 message_update 行都带「截至当前的完整消息」。
    // 回调收敛到至多每 streamThrottleMs 一次。transcript 只是剥掉快照后的尾部，正文由按行吸收的状态给出。
    let emitTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEmitAt = 0;
    const streamThrottleMs = Number(getConfig("SUBAGENT_STREAM_THROTTLE_MS") ?? "") || 150;
    const finish = (r: AgentResult) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      if (emitTimer) clearTimeout(emitTimer);
      unregister();
      launch.cleanup();
      resolve(r);
    };

    const child = spawn(launch.command, launch.args, {
      ...launch.spawnOptions,
      env: launch.env,
    });
    const unregister = registerSubagentProcess(cwd, child);
    let pending = ""; // 当前尚未换行的一行。行一结束就丢掉，不把各帧快照拼进一条字符串。
    let transcript = "";
    const textState = createTextExtractState();
    let stderr = "";
    let doneSeen = false; // 已从事件流解析到 agent_end（logical 完成）
    // 对齐官方 waitForChildProcess（earendil-works/pi#5303）：以 `exit` 为进程结束的权威信号；退出后给
    // stdout/stderr 一段空闲宽限（每来一块数据就重置），既不丢尾部输出，也不死等可能永不触发的 `close`
    // （子代理可能拉起 MCP 等孙进程占住管道）。logical 完成（agent_end）则主动 killTree，由 exit/close 收尾。
    let exited = false;
    let exitCode: number | null = null;
    let stdoutEnded = child.stdout == null;
    let stderrEnded = child.stderr == null;
    const exitGraceMs = Number(getConfig("SUBAGENT_EXIT_GRACE_MS") ?? "") || 100;

    // text 用 getter 惰性求值——并行/链式/后台路径的 onUpdate 只做心跳、不读 payload。
    const emitUpdate = (): void => {
      if (!opts.onUpdate) return;
      lastEmitAt = Date.now();
      const tail = transcript;
      opts.onUpdate({
        get text() {
          return extractedText(textState);
        },
        transcript: tail,
      });
    };
    const scheduleEmit = (): void => {
      if (!opts.onUpdate) return;
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= streamThrottleMs) {
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = undefined;
        }
        emitUpdate();
        return;
      }
      if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = undefined;
          if (!settled) emitUpdate();
        }, streamThrottleMs - elapsed);
      }
    };

    const killTree = (): void => killProcessTree(child);

    // 由累计 buffer 构造终态结果：见到 agent_end（logical 完成）则记 ok，即使随后 killTree 触发非 0
    // 退出码也算成功；否则按退出码判定。
    const finalizeFromBuffers = (closeOrExitCode: number | null): void => {
      flushPending();
      const code = doneSeen ? 0 : closeOrExitCode ?? -1;
      const ok = doneSeen || code === 0;
      finish({
        ok,
        output: extractedText(textState),
        exitCode: code,
        error: ok ? undefined : stderr.slice(0, 2000) || undefined,
        transcript,
      });
    };
    // 退出后 stdio 空闲宽限：每来一块数据就重置，读完尾部再收尾（官方 #5303 防截断）。
    const armExitGrace = (): void => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalizeFromBuffers(exitCode), exitGraceMs);
    };
    const maybeFinalizeAfterExit = (): void => {
      if (exited && !settled && stdoutEnded && stderrEnded) finalizeFromBuffers(exitCode);
    };
    // logical 完成收尾：子代理可能因 MCP/孙进程占住事件循环而不自行退出，主动 killTree，由后续
    // exit/close + 宽限收尾（官方模式），避免干等 idle/hard 超时。
    const markDone = (): void => {
      if (doneSeen) return;
      doneSeen = true;
      killTree();
      armExitGrace();
    };
    // 解析一行事件：返回是否为 agent_end；顺带维护 inTool（quiet 完成兜底据此防在工具执行中误判）。
    const handleEventLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      let ty: string | undefined;
      try {
        ty = (JSON.parse(trimmed) as { type?: string })?.type;
      } catch {
        return false;
      }
      if (ty === "tool_execution_start") inTool = true;
      else if (ty === "tool_execution_end") inTool = false;
      return ty === "agent_end";
    };
    const noteLine = (line: string): void => {
      absorbJsonlLine(textState, line);
      transcript = appendTranscriptTail(transcript, slimTranscriptJsonLine(line));
      if (handleEventLine(line)) markDone();
    };
    // 拆出已换行的行并立刻丢掉原文。半行留在 pending。
    const consumeCompleteLines = (): void => {
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        const rest = pending.slice(nl + 1);
        pending = rest ? Buffer.from(rest, "utf8").toString("utf8") : "";
        noteLine(line);
      }
    };
    // 末尾无换行的残行：agent_end 常是最后一个事件，子进程若 hang 可能输出它后既不补换行也不退出。
    // 只在看起来已是完整 JSON（trim 后以 } 结尾）时补判一次。
    const consumeDanglingAgentEnd = (): void => {
      const rest = pending.trimEnd();
      if (!rest.endsWith("}") || !handleEventLine(rest)) return;
      pending = "";
      absorbJsonlLine(textState, rest);
      transcript = appendTranscriptTail(transcript, slimTranscriptJsonLine(rest));
      markDone();
    };
    const flushPending = (): void => {
      consumeCompleteLines();
      if (!pending.trim()) {
        pending = "";
        return;
      }
      const rest = pending;
      pending = "";
      absorbJsonlLine(textState, rest);
      transcript = appendTranscriptTail(transcript, slimTranscriptJsonLine(rest));
      if (handleEventLine(rest)) markDone();
    };

    // Idle timeout: a sub-agent is "stuck" only when it emits no output for
    // idleMs — not when its total runtime exceeds a fixed budget. Every chunk of
    // real output re-arms the timer, so a slow-but-working agent is never killed
    // mid-flight. A generous hard cap (SUBAGENT_MAX_MS, default idle x10) still
    // bounds the worst case (e.g. an agent that dribbles output forever).
    const idleMs = opts.timeoutMs ?? timeoutMs();
    // 首字节/启动宽限：从 spawn 到吐出第一个 stdout，要经历冷启动 + 连 MCP + 等 LLM 首 token
    //（慢 / 限流 / reasoning 模型可能很久）。这段「还没开始产出」的窗口若按常规 idle 计时，正在
    // 排队 / 思考的子代理会被误杀。故首字节前用更长的 startupMs，收到首字节后才切回常规 idleMs。
    const startupMs = Number(getConfig("SUBAGENT_STARTUP_MS") ?? "") || Math.max(idleMs * 2, 300_000);
    // 超时杀掉时若已产出实质文本，标记 partial：调用方据此保留「已写部分」而非当作纯失败丢弃。
    const timeoutResult = (error: string): AgentResult => {
      flushPending();
      const output = extractedText(textState);
      return { ok: false, output, exitCode: -1, error, transcript, partial: output.trim().length > 0 };
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const waitMs = sawOutput ? idleMs : startupMs;
      idleTimer = setTimeout(() => {
        killTree();
        finish(
          timeoutResult(
            sawOutput
              ? `idle timeout: no output for ${Math.round(idleMs / 1000)}s`
              : `startup timeout: no output for ${Math.round(startupMs / 1000)}s`,
          ),
        );
      }, waitMs);
    };
    armIdle();

    const maxMs = Number(getConfig("SUBAGENT_MAX_MS") ?? "") || idleMs * 10;
    hardTimer = setTimeout(() => {
      killTree();
      finish(timeoutResult(`hard timeout after ${Math.round(maxMs / 1000)}s`));
    }, maxMs);

    // Quiet-complete 兜底：少数情况下子代理产出最终输出后，既不发可识别的 agent_end、又因 MCP/孙进程
    // 占住管道不自行退出（exit 不触发）。此时若已产出实质文本、且当前不在工具执行中，stdout 安静超过
    // quietMs 即按「完成」收尾(success)，而不是干等满 idle 当卡死杀。默认 60s(比常见工具执行更长以防
    // 误判)；设 0 可禁用，跑超长工具的场景可调大 SUBAGENT_QUIET_MS。agent_end 能被识别时(A 路径)本兜底
    // 不会触发(markDone 已置 doneSeen)，故二者互不干扰。
    const quietMs = Number(getConfig("SUBAGENT_QUIET_MS") ?? "") || 60000;
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (quietMs <= 0) return;
      quietTimer = setTimeout(() => {
        if (settled || doneSeen || inTool || !sawOutput) return;
        if (extractedText(textState).trim().length > 0) markDone();
      }, quietMs);
    };

    child.stdout?.on("data", (d: Buffer) => {
      pending += d.toString();
      sawOutput = true; // 收到首字节 → 之后用常规 idleMs（而非更长的 startupMs）
      consumeCompleteLines();
      consumeDanglingAgentEnd();
      armIdle(); // 有输出 → 重置 idle（卡死）计时器
      armQuiet(); // 有输出 → 重置 quiet（静默完成）计时器
      scheduleEmit(); // 节流回调：避免每 token 把全量 transcript 经 IPC 推送
      if (exited) armExitGrace(); // 进程已退出但仍在吐尾部数据：重置宽限，读完再收尾（不截断）
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (exited) armExitGrace(); // 退出后 stderr 仍在写：同样重置宽限
    });
    child.stdout?.once("end", () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    });
    child.stderr?.once("end", () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    });

    opts.signal?.addEventListener(
      "abort",
      () => {
        killTree();
        flushPending();
        finish({ ok: false, output: extractedText(textState), exitCode: -1, error: "aborted", transcript });
      },
      { once: true },
    );

    child.on("error", (e) => finish({ ok: false, output: "", exitCode: -1, error: e.message, transcript }));
    // 官方 waitForChildProcess 模式：`exit` 是进程结束的权威信号（即便 `close` 因孙进程占住管道而永不
    // 触发）。退出后若 stdio 已结束立即收尾，否则给一段空闲宽限把尾部读完再收尾。`close`（若触发）走同一路径。
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armExitGrace();
    });
    child.on("close", (code) => finalizeFromBuffers(code));
  });
}
