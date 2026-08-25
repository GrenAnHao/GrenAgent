// lsp：把语言服务器的语义能力暴露给模型（定义/引用/悬停/诊断/符号）。
//
// 按 (root, language) 复用一个 LspClient（spawn 对应服务器）。只读类工具，进 Ask/Plan 白名单。
// 与 ast-tools 互补：文本或结构搜索用于全局探索，LSP 用于精确、实时的类型语义。
// 安全重命名(lsp_rename, WorkspaceEdit 应用)列二期；UTF-16 列精修、前端诊断面板亦二期。
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LspClient } from "./client.js";
import { type ToolLocation, normalizeLocations } from "./convert.js";
import { findRoot, isAvailable, languageForPath, serverForLanguage } from "./servers.js";

const POS_PARAMS = Type.Object({
  path: Type.String({ description: "文件路径（相对工作区或绝对）" }),
  line: Type.Number({ description: "行号（1-based）" }),
  column: Type.Number({ description: "列号（1-based）" }),
});

interface Diagnostic {
  range?: { start?: { line: number; character: number } };
  severity?: number;
  message?: string;
  source?: string;
}

const SEVERITY = ["", "error", "warning", "info", "hint"];

function formatLocations(locs: ToolLocation[], cwd: string): string {
  if (locs.length === 0) return "（无结果）";
  return locs.map((l) => `${relative(cwd, l.path) || l.path}:${l.line}:${l.column}`).join("\n");
}

function hoverText(hover: unknown): string {
  const c = (hover as { contents?: unknown })?.contents;
  if (!c) return "（无悬停信息）";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === "string" ? x : ((x as { value?: string })?.value ?? ""))).join("\n");
  }
  return (c as { value?: string }).value ?? "（无悬停信息）";
}

function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return "（无诊断）";
  return diags
    .map((d) => {
      const ln = (d.range?.start?.line ?? 0) + 1;
      const col = (d.range?.start?.character ?? 0) + 1;
      const sev = SEVERITY[d.severity ?? 1] ?? "info";
      return `${sev} ${ln}:${col} ${d.message ?? ""}${d.source ? ` [${d.source}]` : ""}`;
    })
    .join("\n");
}

interface SymbolNode {
  name?: string;
  kind?: number;
  range?: { start?: { line: number } };
  location?: { range?: { start?: { line: number } } };
  children?: SymbolNode[];
}

function formatSymbols(symbols: unknown): string {
  const out: string[] = [];
  const walk = (arr: SymbolNode[] | undefined, depth: number) => {
    for (const s of arr ?? []) {
      const line = (s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1;
      out.push(`${"  ".repeat(depth)}${s.name ?? "?"} (${line})`);
      if (Array.isArray(s.children)) walk(s.children, depth + 1);
    }
  };
  walk(symbols as SymbolNode[], 0);
  return out.length > 0 ? out.join("\n") : "（无符号）";
}

export default function (pi: ExtensionAPI) {
  console.error("[lsp] extension loaded");

  const clients = new Map<string, LspClient>();
  const availability = new Map<string, boolean>();

  const clientFor = (absPath: string, cwd: string): { client?: LspClient; error?: string } => {
    const language = languageForPath(absPath);
    if (!language) return { error: `不支持的文件类型：${absPath}` };
    const spec = serverForLanguage(language);
    if (!spec) return { error: `没有 ${language} 的语言服务器配置` };
    const root = findRoot(absPath, spec.rootMarkers, cwd);
    const key = `${root}\u0000${language}`;
    let client = clients.get(key);
    if (!client) {
      let ok = availability.get(spec.cmd);
      if (ok === undefined) {
        ok = isAvailable(spec.cmd);
        availability.set(spec.cmd, ok);
      }
      if (!ok) return { error: `未找到语言服务器 ${spec.cmd}，请先安装它再使用 LSP 工具。` };
      client = new LspClient(spec, root);
      clients.set(key, client);
    }
    return { client };
  };

  const absOf = (path: string, cwd: string) => (isAbsolute(path) ? path : resolve(cwd, path));

  const register = (
    name: string,
    description: string,
    run: (client: LspClient, abs: string, line: number, column: number, cwd: string) => Promise<string>,
    withPos = true,
  ) => {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters: withPos
        ? POS_PARAMS
        : Type.Object({ path: Type.String({ description: "文件路径（相对工作区或绝对）" }) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const abs = absOf(params.path ?? "", ctx.cwd);
        const { client, error } = clientFor(abs, ctx.cwd);
        if (error || !client) return { content: [{ type: "text", text: error ?? "无可用语言服务器" }], details: undefined };
        try {
          const text = await run(
            client,
            abs,
            (params as { line?: number }).line ?? 1,
            (params as { column?: number }).column ?? 1,
            ctx.cwd,
          );
          return { content: [{ type: "text", text }], details: undefined };
        } catch (err) {
          return { content: [{ type: "text", text: `LSP 调用失败：${(err as Error).message}` }], details: undefined };
        }
      },
    });
  };

  register("lsp_definition", "跳转到符号定义（返回 path:line:column）。", async (c, abs, line, col, cwd) =>
    formatLocations(normalizeLocations(await c.definition(abs, line, col)), cwd),
  );
  register("lsp_references", "查找符号的所有引用（含声明）。", async (c, abs, line, col, cwd) =>
    formatLocations(normalizeLocations(await c.references(abs, line, col)), cwd),
  );
  register("lsp_hover", "查看符号的类型/文档（悬停信息）。", async (c, abs, line, col) =>
    hoverText(await c.hover(abs, line, col)),
  );
  register(
    "lsp_document_symbols",
    "列出文件内的符号（函数/类/变量）大纲。",
    async (c, abs) => formatSymbols(await c.documentSymbols(abs)),
    false,
  );
  register(
    "lsp_diagnostics",
    "获取文件的诊断（错误/警告/提示），来自语言服务器。",
    async (c, abs) => formatDiagnostics(await c.diagnosticsFor(abs)),
    false,
  );

  pi.on("session_shutdown", async () => {
    for (const c of clients.values()) c.dispose();
    clients.clear();
  });
}
