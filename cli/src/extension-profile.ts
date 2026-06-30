// 扩展加载 profile：真对话模式（chat）裁掉重代码智能扩展，缩短加载、降低开销；项目模式（project）全载。
// safety 永不剔除（护栏不能因"精简"丢失）。纯逻辑，便于单测。

export const CHAT_EXCLUDED = new Set<string>([
  "lsp",
  "dap",
  "code-intel",
  "code-search",
  "ast-tools",
  "hashline",
  "code-exec",
  "debug-tools",
  "diagnostics",
  "after-tool-feedback",
]);

export type ExtensionProfile = "project" | "chat";

export function filterExtensionsByProfile<T extends { name: string }>(
  exts: T[],
  profile: ExtensionProfile,
): T[] {
  if (profile !== "chat") return exts;
  return exts.filter((e) => e.name === "safety" || !CHAT_EXCLUDED.has(e.name));
}
