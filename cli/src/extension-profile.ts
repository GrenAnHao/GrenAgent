// 扩展加载 profile：真对话模式（chat）裁掉重代码智能扩展，缩短加载、降低开销；项目模式（project）全载。
// safety 永不剔除（护栏不能因"精简"丢失）。纯逻辑，便于单测。

export const CHAT_EXCLUDED = new Set<string>([
  "lsp",
  "dap",
  "ast-tools",
  "hashline",
  "code-exec",
  "debug-tools",
  "diagnostics",
  "after-tool-feedback",
]);

/**
 * Electron 产品常驻：无 manifest 也要加载。
 * 重型 / 危险扩展（与 CHAT_EXCLUDED 对齐）不在此列，须登记为托管插件后才进入白名单。
 */
export const CORE_ALWAYS_ON = new Set<string>([
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
  "present",
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

export type ExtensionProfile = "project" | "chat";

export function filterExtensionsByProfile<T extends { name: string }>(
  exts: T[],
  profile: ExtensionProfile,
): T[] {
  if (profile !== "chat") return exts;
  return exts.filter((e) => e.name === "safety" || !CHAT_EXCLUDED.has(e.name));
}

export function filterManagedExtensions<T extends { name: string; manifest?: { id: string } }>(
  extensions: T[],
  raw: string | undefined,
): T[] {
  if (!raw?.trim()) return extensions;
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return extensions.filter((entry) => !entry.manifest);
  }
  const allowed = new Set(ids as string[]);
  return extensions.filter((entry) => CORE_ALWAYS_ON.has(entry.name) || (entry.manifest !== undefined && allowed.has(entry.manifest.id)));
}
