// dream/distill 子代理：registry 登记 + spawnPiAgent JSON 流（右坞/ Bot 菜单可见）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { spawnPiAgent } from "../multi-agent/runner.js";
import { SubAgentRegistry } from "../multi-agent/registry.js";
import { DISTILL_PERSONA, DISTILL_TASK, DREAM_PERSONA, DREAM_TASK } from "./personas.js";

const NETWORK_DENY = [
  "web_search",
  "web_search_multi",
  "fetch_url",
  "fetch_llms",
  "fetch_html",
  "fetch_markdown",
  "fetch_txt",
  "fetch_json",
  "fetch_github_readme",
  "fetch_web_content",
  "image_gen",
];

// dream/distill 子代理工具白名单（对齐设计 §2，用真实工具名）：只读分析 + 写记忆/资产所需。
// 注意 write/edit/bash 仍在内（dream 写 MEMORY.md、distill 写资产文件需要），「不碰源码」仍由
// persona 约束；白名单的作用是把能力面收敛到这组、排除 code-exec/lsp/ast 等无关重工具。
const EVOLVE_TOOLS = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "find",
  "ls",
  "bash",
  "memory_save",
  "memory_recall",
  "memory_update",
  "history_search",
];

const TASK_LABEL: Record<"dream" | "distill", Record<"manual" | "auto", string>> = {
  dream: { manual: "Dream（手动）", auto: "Auto Dream" },
  distill: { manual: "Distill（手动）", auto: "Auto Distill" },
};

function registryFor(cwd: string): SubAgentRegistry {
  return new SubAgentRegistry(join(cwd, ".pi", "subagents", "registry.db"));
}

function loadPersona(agent: "dream" | "distill"): string {
  const fallback = agent === "dream" ? DREAM_PERSONA : DISTILL_PERSONA;
  try {
    return readFileSync(join(getAgentDir(), "agents", `${agent}.md`), "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
}

function taskText(agent: "dream" | "distill"): string {
  return agent === "dream" ? DREAM_TASK : DISTILL_TASK;
}

function resolveModel(explicit?: string): string | undefined {
  const fromOpt = explicit?.trim();
  if (fromOpt) return fromOpt;
  const fromCfg = getConfig("SELF_EVOLVE_MODEL")?.trim();
  if (fromCfg) return fromCfg;
  return getConfig("SUBAGENT_MODEL")?.trim() || undefined;
}

function evolveEnv(model?: string): Record<string, string> {
  // 只返回覆盖项：spawnPiAgent 的子进程本就继承 process.env，无需在 opts.env 再塞全量；
  // 全量会被 buildSubagentRuntimeConfig 写进临时 runtime-config 文件（含可能的 secrets）。
  return {
    SELF_EVOLVE_CHILD: "1",
    ...(model ? { SUBAGENT_MODEL: model } : {}),
    SAFETY_DENY_TOOLS: [process.env.SAFETY_DENY_TOOLS, ...NETWORK_DENY].filter(Boolean).join(","),
  };
}

export interface EvolveJobOpts {
  agent: "dream" | "distill";
  cwd: string;
  source: "manual" | "auto";
  model?: string;
  timeoutMs: number;
}

export interface EvolveJobResult {
  id: string;
  ok: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

const inflight = new Map<string, Promise<EvolveJobResult>>();
// 同 (agent, cwd) 去重：避免连续 /dream 或 auto+manual 叠加并发起多个子代理同时写同一 MEMORY.md
// （pi edit 无跨进程锁，并发 read-modify-write 会互相覆盖）。运行中再次触发直接复用现有任务。
const activeByKey = new Map<string, string>();

export function startEvolveJob(
  opts: EvolveJobOpts,
  hooks?: { onComplete?: (r: EvolveJobResult) => void },
): { id: string; already: boolean } {
  const key = `${opts.agent}:${opts.cwd}`;
  const running = activeByKey.get(key);
  if (running) return { id: running, already: true };

  const registry = registryFor(opts.cwd);
  const id = SubAgentRegistry.genId();
  const chosenModel = resolveModel(opts.model);
  registry.create({
    id,
    task: TASK_LABEL[opts.agent][opts.source],
    profile: JSON.stringify({ preset: opts.agent, source: opts.source }),
    model: chosenModel ?? null,
  });
  activeByKey.set(key, id);

  // spawnPiAgent 在返回 Promise 前仍有同步阶段（resolvePiCommand 等）。若它同步抛错，下方的
  // .then/.catch/.finally 链不会建立、finally 不会执行，activeByKey 就会残留 —— 该 (agent,cwd)
  // 之后被永久判为「运行中」，dream/distill 再也触发不了。故用 try/catch 兜住同步路径，与异步
  // 路径共用同一 cleanup。
  const cleanup = () => {
    activeByKey.delete(key);
    registry.close();
    inflight.delete(id);
  };

  let p: Promise<EvolveJobResult>;
  try {
    p = spawnPiAgent(opts.cwd, taskText(opts.agent), {
      model: chosenModel,
      systemPrompt: loadPersona(opts.agent),
      tools: EVOLVE_TOOLS,
      timeoutMs: opts.timeoutMs,
      env: evolveEnv(chosenModel),
      // 把子代理的流式 JSONL transcript 增量写进 registry（替代纯心跳 touch——progress 内部也 bump
      // updatedAt，故心跳作用保留）。前端右坞面板轮询 registry 即可像主对话一样实时回放工具调用+文本流。
      onUpdate: (u) => registry.progress(id, u.transcript),
    })
      .then((r) => {
        registry.finish(id, {
          status: r.ok ? "done" : "error",
          output: r.output,
          error: r.error ?? null,
          exitCode: r.exitCode,
          transcript: r.transcript,
        });
        const result: EvolveJobResult = {
          id,
          ok: r.ok,
          output: r.output,
          error: r.error,
          exitCode: r.exitCode,
        };
        hooks?.onComplete?.(result);
        return result;
      })
      .catch((e) => {
        const msg = String((e as Error)?.message ?? e);
        registry.finish(id, { status: "error", error: msg, exitCode: -1 });
        const result: EvolveJobResult = { id, ok: false, output: "", error: msg, exitCode: -1 };
        hooks?.onComplete?.(result);
        return result;
      })
      .finally(cleanup);
  } catch (e) {
    // 同步抛错：.then/.catch/.finally 都不会触发。手动把 registry row 标为 error（与异步 .catch
    // 路径一致），再回滚（此时 inflight 尚未 set，cleanup 内 inflight.delete 为 no-op）。
    const msg = String((e as Error)?.message ?? e);
    registry.finish(id, { status: "error", error: msg, exitCode: -1 });
    cleanup();
    throw e;
  }

  inflight.set(id, p);
  return { id, already: false };
}

/** 测试与需要同步等待时使用 */
export function waitEvolveJob(id: string, cwd: string): Promise<EvolveJobResult> {
  const pending = inflight.get(id);
  if (pending) return pending;
  const registry = registryFor(cwd);
  const row = registry.get(id);
  registry.close();
  return Promise.resolve({
    id,
    ok: row?.status === "done",
    output: row?.output ?? "",
    error: row?.error ?? undefined,
    exitCode: row?.exitCode ?? -1,
  });
}
