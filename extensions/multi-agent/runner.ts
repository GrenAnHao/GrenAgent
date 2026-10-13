// 子代理共用的部分：结果类型、模型路由、worker 入口、派生运行时配置（能力限制、MCP、记忆开关）。
// 子代理不再跑 `pi --mode json -p` 再解析 stdout：两个后端都是真会话（进程内，或 worker 进程里经 RPC，
// 见 worker-session.ts）。打印模式的启动和 JSONL 解析只剩 im-platforms 在用，搬到了 im-platforms/pi-process.ts。

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfig, withoutSensitiveProcessConfig } from "../_shared/runtime-config.js";
import { resolveMcpServers } from "./capability.js";
import { readMaxDepth } from "./depth.js";

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
  /** Set by embedded runner: the level the child session actually runs at (after model clamping). */
  thinkingLevel?: string;
}

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
function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function normPrefix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 父会话的只读 / 写白名单（当前会话配置）叠到子代理档案上：只读向下传；写白名单只留落在父白名单里的项。 */
export function inheritedFsLimits(extraEnv: Record<string, string>): Record<string, string> {
  const parentReadonly = getConfig("SAFETY_READONLY");
  if (parentReadonly === "1" || parentReadonly?.toLowerCase() === "true") return { SAFETY_READONLY: "1" };
  const parentAllow = splitList(getConfig("SAFETY_WRITE_ALLOW")).map(normPrefix);
  if (parentAllow.length === 0) return {};
  if (extraEnv.SAFETY_READONLY === "1") return {};
  const childAllow = splitList(extraEnv.SAFETY_WRITE_ALLOW).map(normPrefix);
  const narrowed = childAllow.filter((c) => parentAllow.some((p) => c.startsWith(p)));
  return { SAFETY_WRITE_ALLOW: (narrowed.length > 0 ? narrowed : parentAllow).join(",") };
}

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
  // 父会话自己的能力限制只能收紧、不能被子代理档案放宽：deny 取并集，只读向下传，写白名单取交集。
  // safety 不再先读 process.env，这些限制必须写进子代理的配置（进程内是 ALS，worker 是派生配置文件）。
  const parentDeny = (getConfig("SAFETY_DENY_TOOLS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const tool of parentDeny) denyTools.add(tool);
  const env = withoutSensitiveProcessConfig({
    ...extraEnv,
    ...inheritedFsLimits(extraEnv),
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

