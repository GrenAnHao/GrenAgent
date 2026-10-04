// after-tool-feedback: edit/write 后自动跑诊断，把结果 patch 进 tool result 回灌给模型，
// 让模型同轮看到并修复自己引入的错误。纯扩展，复用 diagnostics 的 runChecks/parsers。
// 依赖上游 0.79.10 的 `tool_result` 钩子（返回 ToolResultEventResult 可改 content）。全程 fail-soft。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { resolveCommands } from "../diagnostics/config.js";
import { type Diagnostic, parseEslintJson, parseTsc } from "../diagnostics/parsers.js";
import { runChecks } from "../diagnostics/runner.js";
import { patchContent, renderDiagnostics } from "./render.js";
import { diffNewDiagnostics, extractEditedPaths } from "./select.js";

const enabled = () => (getConfig("AFTER_TOOL_FEEDBACK") ?? "1") !== "0";
const maxLines = () => Number(getConfig("AFTER_TOOL_MAX") ?? "30") || 30;
const timeoutMs = () => Number(getConfig("AFTER_TOOL_TIMEOUT_MS") ?? "60000") || 60000;

function parse(source: string, stdout: string, stderr: string): Diagnostic[] {
  return source === "eslint" ? parseEslintJson(stdout || stderr) : parseTsc(`${stdout}\n${stderr}`);
}

export default function (pi: ExtensionAPI) {
  // 每文件记上次诊断，用于只回灌「新增」诊断、避免反复刷屏。
  const lastByFile = new Map<string, Diagnostic[]>();

  pi.on("tool_result", async (event, ctx) => {
    if (!enabled()) return undefined;
    const paths = extractEditedPaths({ toolName: event.toolName, input: event.input as Record<string, unknown> });
    if (paths.length === 0) return undefined;
    try {
      const commands = resolveCommands(ctx.cwd);
      if (commands.length === 0) return undefined;
      const raws = await runChecks(ctx.cwd, commands, ctx.signal ?? undefined, timeoutMs());
      const all = raws.flatMap((r) => parse(r.source, r.stdout, r.stderr));
      const target = paths[0].replace(/\\/g, "/");
      const forFile = all.filter((d) => d.file.replace(/\\/g, "/").includes(target));
      const fresh = diffNewDiagnostics(lastByFile.get(paths[0]) ?? [], forFile);
      lastByFile.set(paths[0], forFile);
      if (fresh.length === 0) return undefined;
      const structured = (event as { structuredContent?: unknown }).structuredContent;
      return {
        content: patchContent(event.content, renderDiagnostics(fresh, maxLines())),
        ...(structured !== undefined ? { structuredContent: structured } : {}),
      };
    } catch (e) {
      // fail-soft：诊断失败绝不改/阻断 tool result。
      console.error("[after-tool-feedback] 诊断失败（忽略）:", e instanceof Error ? e.message : e);
      return undefined;
    }
  });
}
