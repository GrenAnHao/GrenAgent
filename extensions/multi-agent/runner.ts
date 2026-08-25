// Spawn isolated pi sub-agents (separate processes) and collect their output.
// Mirrors the official subagent example: `pi --mode json -p --no-session <task>`.

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfig, withoutSensitiveProcessConfig } from "../_shared/runtime-config.js";
import { resolveMcpServers } from "./capability.js";

export interface AgentResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
  /** Killed by idle/hard timeout but had already produced real output — caller should keep it. */
  partial?: boolean;
  /** Raw `--mode json` JSONL stream (one AgentEvent per line) for UI replay. */
  transcript: string;
}

/** Streaming update payload: latest final text plus the full raw JSONL transcript. */
export interface AgentUpdate {
  text: string;
  transcript: string;
}

interface PiEvent {
  type?: string;
  role?: string;
  text?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

const timeoutMs = () => Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "300000") || 300000;

/** User-configured sub-agent model. Mode `inherit` forces the main-agent default; otherwise use `SUBAGENT_MODEL` (empty → inherit). */
export function resolveSubagentModel(): string | undefined {
  if (getConfig("SUBAGENT_MODE")?.trim() === "inherit") return undefined;
  const raw = getConfig("SUBAGENT_MODEL")?.trim();
  return raw || undefined;
}

export function resolvePiCommand(): { cmd: string; baseArgs: string[] } {
  // PI_BIN explicitly overrides; otherwise reuse the current executable (the
  // sidecar binary itself under bun --compile) so desktop needs no global `pi`.
  const piBin = getConfig("PI_BIN");
  if (piBin) return { cmd: piBin, baseArgs: [] };
  return { cmd: process.execPath, baseArgs: [] };
}

export function buildSubagentSkillArgs(root: string | undefined): string[] {
  const managedRoot = root?.trim();
  return managedRoot ? ["--skill", managedRoot] : [];
}

export function extractFinalText(jsonlOutput: string): string {
  const lines = jsonlOutput.split(/\r?\n/).filter((l) => l.trim());
  let text = "";
  for (const line of lines) {
    let ev: PiEvent | null = null;
    try {
      ev = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }
    const role = ev.message?.role ?? ev.role;
    if (role !== "assistant") continue;
    const content = ev.message?.content ?? ev.content ?? ev.text;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const t = content
        .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
        .map((p) => p.text)
        .join("");
      if (t) text = t;
    }
  }
  return text || jsonlOutput.slice(-4000).trim();
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
  // 子代理一律禁止再 spawn 子代理：把 spawn_agent 并入 SAFETY_DENY_TOOLS（safety 扩展按工具名硬拦），
  // 与 index.ts 的 PI_IS_SUBAGENT 守卫互为独立的双重防线；且经派生 runtime-config 落盘，
  // 不只依赖 env 单链传递，更可靠。保留 extraEnv（profile）已有的 deny 列表。
  const denyTools = new Set(
    (extraEnv.SAFETY_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  denyTools.add("spawn_agent");
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

export async function spawnPiAgent(
  cwd: string,
  task: string,
  opts: {
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
  } = {},
): Promise<AgentResult> {
  const { cmd, baseArgs } = resolvePiCommand();
  // --no-approve: sub-agents are isolated one-shot runs that must NOT load
  // project-local .pi resources (extensions / MCP / skills / SYSTEM.md). Pinning
  // it keeps them lightweight and deterministic regardless of the user's global
  // defaultProjectTrust — an "always" setting would otherwise make every
  // sub-agent re-load project-local MCP, re-creating the cold-start stampede.
  const args = [
    ...baseArgs,
    ...buildSubagentSkillArgs(getConfig("TDAI_SKILLS_ROOT")),
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
  ];
  const model = opts.model ?? resolveSubagentModel();
  if (model) args.push("--model", model);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  // Named-agent system prompt: write to a temp .md, append via --append-system-prompt,
  // and clean it up when the run finishes (cleanupPrompt in finish below).
  let promptFile: string | undefined;
  if (opts.systemPrompt && opts.systemPrompt.trim()) {
    promptFile = join(tmpdir(), `pi-subagent-sp-${randomBytes(4).toString("hex")}.md`);
    try {
      writeFileSync(promptFile, opts.systemPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptFile);
    } catch {
      promptFile = undefined;
    }
  }
  args.push(task);

  return new Promise<AgentResult>((resolve) => {
    const rc = buildSubagentRuntimeConfig(opts.mcp, opts.env);
    const cleanupPrompt = (): void => {
      if (!promptFile) return;
      try {
        rmSync(promptFile, { force: true });
      } catch {
        /* already gone */
      }
      promptFile = undefined;
    };
    let settled = false;
    let sawOutput = false; // 是否已收到子进程首个 stdout 字节（用于首字节/启动宽限）
    let inTool = false; // 是否在工具执行中（tool_execution_start..end 之间）：quiet 完成兜底据此防误判
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let postExitTimer: ReturnType<typeof setTimeout> | undefined;
    // 流式 onUpdate 节流：子代理 `--mode json` 的每个 message_update 行都带「截至当前的完整消息」，
    // 故 stdout 随单条消息呈 O(n²) 膨胀。若每个 stdout chunk（≈每 token）都回调，就会每 token
    // 重解析整段 stdout（extractFinalText）并把全量 transcript 经 IPC 推到前端，造成「子代理一跑界面就卡」。
    // 这里把回调收敛到至多每 streamThrottleMs 一次（leading + trailing），终态由 finish 的完整 transcript 兜底。
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
      rc.cleanup();
      cleanupPrompt();
      resolve(r);
    };

    const child = spawn(cmd, args, {
      cwd,
      // print mode reads piped stdin; without "ignore" the child blocks waiting
      // for stdin EOF and never runs the task → sub-agent appears to "time out".
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // rc.env = profile env (fs/net/tools) + memory-off + the resolved
        // MCP_SERVERS (on-demand per profile.mcp). Applied BOTH as env and inside
        // the derived runtime-config file (rc.path) below — getConfig reads the
        // file first, so env alone can't undo a value already in PI_RUNTIME_CONFIG.
        ...rc.env,
        // Point the child at the derived sub-agent config so the overrides also
        // win at the file level. Omitted when there is no parent config file —
        // then the env above is already authoritative.
        ...(rc.path ? { PI_RUNTIME_CONFIG: rc.path } : {}),
        // Tag every spawned child as a sub-agent so it refuses to spawn its own
        // sub-agents (recursion guard). Set last so callers can't override it.
        PI_IS_SUBAGENT: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let doneSeen = false; // 已从事件流解析到 agent_end（logical 完成）
    // 对齐官方 waitForChildProcess（earendil-works/pi#5303）：以 `exit` 为进程结束的权威信号；退出后给
    // stdout/stderr 一段空闲宽限（每来一块数据就重置），既不丢尾部输出，也不死等可能永不触发的 `close`
    // （子代理可能拉起 MCP 等孙进程占住管道）。logical 完成（agent_end）则主动 killTree，由 exit/close 收尾。
    let exited = false;
    let exitCode: number | null = null;
    let stdoutEnded = child.stdout == null;
    let stderrEnded = child.stderr == null;
    let parseOffset = 0; // 行缓冲游标：逐行 JSON 解析检测 agent_end，避免对整段 buffer 反复跑正则（O(n²)）
    const exitGraceMs = Number(getConfig("SUBAGENT_EXIT_GRACE_MS") ?? "") || 100;

    // 在发射时刻才对当前 stdout 快照算 text/transcript；text 用 getter 惰性求值——并行/链式/后台
    // 路径的 onUpdate 只做心跳（registry.touch）、不读 payload，因此它们完全不触发 extractFinalText。
    const emitUpdate = (): void => {
      if (!opts.onUpdate) return;
      lastEmitAt = Date.now();
      const snapshot = stdout;
      opts.onUpdate({
        get text() {
          return extractFinalText(snapshot);
        },
        transcript: snapshot,
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

    // Kill the child AND its descendants. A one-shot sub-agent may have spawned
    // MCP stdio servers (or other helpers) whose open pipes keep the process tree
    // alive; child.kill() alone leaves them orphaned, so on Windows use taskkill
    // /T to take down the whole tree.
    const killTree = (): void => {
      const pid = child.pid;
      if (pid && process.platform === "win32") {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
          return;
        } catch {
          /* fall through to child.kill */
        }
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };

    // 由累计 buffer 构造终态结果：见到 agent_end（logical 完成）则记 ok，即使随后 killTree 触发非 0
    // 退出码也算成功；否则按退出码判定。
    const finalizeFromBuffers = (closeOrExitCode: number | null): void => {
      const code = doneSeen ? 0 : closeOrExitCode ?? -1;
      const ok = doneSeen || code === 0;
      finish({
        ok,
        output: extractFinalText(stdout),
        exitCode: code,
        error: ok ? undefined : stderr.slice(0, 2000) || undefined,
        transcript: stdout,
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
    // 逐行扫描新增 stdout 解析 agent_end（logical 完成）。比对整段 buffer 跑正则更稳（无误判）更省（非 O(n²)）。
    const scanForAgentEnd = (): void => {
      if (doneSeen) return;
      let nl: number;
      while ((nl = stdout.indexOf("\n", parseOffset)) !== -1) {
        const line = stdout.slice(parseOffset, nl);
        parseOffset = nl + 1;
        if (handleEventLine(line)) {
          markDone();
          return;
        }
      }
      // 末尾无换行的残行：agent_end 常是最后一个事件，子进程若 hang（MCP/孙进程占管道）可能输出它后
      // 既不补换行也不退出，逐行扫描（依赖 \n）会永远漏掉它 → 干等 idle 误杀。故对「看起来已是完整
      // JSON」的残行（trim 后以 } 结尾）补判一次；半行不以 } 结尾则跳过，避免每个 chunk 重复 parse。
      const rest = stdout.slice(parseOffset).trimEnd();
      if (rest.endsWith("}") && handleEventLine(rest)) {
        parseOffset = stdout.length;
        markDone();
      }
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
      const output = extractFinalText(stdout);
      return { ok: false, output, exitCode: -1, error, transcript: stdout, partial: output.trim().length > 0 };
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
        if (extractFinalText(stdout).trim().length > 0) markDone();
      }, quietMs);
    };

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      sawOutput = true; // 收到首字节 → 之后用常规 idleMs（而非更长的 startupMs）
      armIdle(); // 有输出 → 重置 idle（卡死）计时器
      armQuiet(); // 有输出 → 重置 quiet（静默完成）计时器
      scheduleEmit(); // 节流回调：避免每 token 全量重解析 + 全量 transcript 经 IPC 推送
      scanForAgentEnd(); // 解析 agent_end（logical 完成）→ killTree + 退出宽限收尾
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
        finish({ ok: false, output: extractFinalText(stdout), exitCode: -1, error: "aborted", transcript: stdout });
      },
      { once: true },
    );

    child.on("error", (e) => finish({ ok: false, output: "", exitCode: -1, error: e.message, transcript: stdout }));
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
