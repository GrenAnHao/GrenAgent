// Spawn isolated pi sub-agents (separate processes) and collect their output.
// Mirrors the official subagent example: `pi --mode json -p --no-session <task>`.

import { spawn } from "node:child_process";
import { getConfig } from "../_shared/runtime-config.js";

export interface AgentResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
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

const timeoutMs = () => Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "120000") || 120000;

/** User-configured sub-agent model (`SUBAGENT_MODEL` env). Empty → inherit main agent default. */
export function resolveSubagentModel(): string | undefined {
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

export async function spawnPiAgent(
  cwd: string,
  task: string,
  opts: { model?: string; signal?: AbortSignal; onUpdate?: (update: AgentUpdate) => void; env?: Record<string, string> } = {},
): Promise<AgentResult> {
  const { cmd, baseArgs } = resolvePiCommand();
  const args = [...baseArgs, "--mode", "json", "-p", "--no-session"];
  const model = opts.model ?? resolveSubagentModel();
  if (model) args.push("--model", model);
  args.push(task);

  return new Promise<AgentResult>((resolve) => {
    let settled = false;
    const finish = (r: AgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = spawn(cmd, args, {
      cwd,
      // print mode reads piped stdin; without "ignore" the child blocks waiting
      // for stdin EOF and never runs the task → sub-agent appears to "time out".
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Sub-agents are isolated one-shot tasks: disable auto knowledge/memory
        // injection, memory capture+extract, and MCP so they start fast and
        // never recurse (each would otherwise re-run embeddings / re-connect MCP).
        KB_AUTO_INJECT: "0",
        MEMORY_AUTO_INJECT: "0",
        MEMORY_AUTO_CAPTURE: "0",
        MEMORY_EXTRACT: "0",
        MCP_SERVERS: "",
        ...(opts.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, output: extractFinalText(stdout), exitCode: -1, error: `timeout after ${timeoutMs()}ms`, transcript: stdout });
    }, timeoutMs());

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (opts.onUpdate) opts.onUpdate({ text: extractFinalText(stdout), transcript: stdout });
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    opts.signal?.addEventListener(
      "abort",
      () => {
        child.kill();
        finish({ ok: false, output: extractFinalText(stdout), exitCode: -1, error: "aborted", transcript: stdout });
      },
      { once: true },
    );

    child.on("error", (e) => finish({ ok: false, output: "", exitCode: -1, error: e.message, transcript: stdout }));
    child.on("close", (code) =>
      finish({
        ok: code === 0,
        output: extractFinalText(stdout),
        exitCode: code ?? -1,
        error: code === 0 ? undefined : stderr.slice(0, 2000) || undefined,
        transcript: stdout,
      }),
    );
  });
}
