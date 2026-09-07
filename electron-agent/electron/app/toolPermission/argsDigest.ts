/** 单条审计参数的字符上限，超出截断。 */
export const MAX_DIGEST_LENGTH = 4_000;

/** 只保留路径、丢弃正文的工具：内容已在 file_checkpoints 的 blob 中（S3），审计里再存一份是浪费。 */
const PATH_ONLY_TOOLS = new Set(['write', 'edit', 'ast_edit', 'hl_edit', 'search_replace', 'str_replace']);

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{"_unserializable":true}';
  }
}

/**
 * 把工具参数裁剪为审计摘要。
 *
 * bash 保留完整命令——审计的主要价值就在于此。写类工具只留路径。
 * 其余工具整体序列化后按长度截断，避免个别工具的大参数撑爆表。
 *
 * 返回值不保证是合法 JSON：截断发生在字符层面，尾部会留下半截字面量（以 … 标记）。
 * tool_audit.args 是给人看的取证字符串，只作展示，不要 JSON.parse 它。
 */
export function digestArgs(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '{}';
  if (tool === 'bash' || tool === 'shell') {
    return stringify({ command: typeof args.command === 'string' ? args.command : '' });
  }
  if (PATH_ONLY_TOOLS.has(tool)) {
    const path = args.path ?? args.file_path ?? args.filePath ?? args.target_file;
    return stringify({ path: typeof path === 'string' ? path : '' });
  }
  const serialised = stringify(args);
  return serialised.length > MAX_DIGEST_LENGTH ? `${serialised.slice(0, MAX_DIGEST_LENGTH - 1)}…` : serialised;
}
