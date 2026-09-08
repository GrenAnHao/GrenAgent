/** 单条审计参数的字符上限，超出截断。 */
export const MAX_DIGEST_LENGTH = 4_000;

/** bash 命令是审计的主要取证对象，给它单独的宽松上限，但不能完全不设——tool_audit 每次调用都写一行。 */
export const MAX_COMMAND_LENGTH = 12_000;

/**
 * 只保留路径、丢弃正文的工具：内容已在 file_checkpoints 的 blob 中（S3），审计里再存一份是浪费。
 *
 * 只有 write 与 edit 够格。ast_edit 与 hl_edit 虽然也是写盘工具，但刻意不列入：
 * 它们的参数里没有任何路径键（ast_edit 是 paths 复数数组，hl_edit 只有 patch、
 * 路径嵌在补丁文本的 [PATH#TAG] 段里），列进来只会让审计写下 {"path":""}，
 * 而这两个恰是 extensions/safety/index.ts:38-40 点名的「绕过写白名单的写盘工具」，
 * 最需要留证。落到通用序列化分支才能把 paths / ops / patch 记进台账。
 */
const PATH_ONLY_TOOLS = new Set(['write', 'edit']);

/**
 * 序列化失败时给出可识别的占位串。
 *
 * ?? '{}' 兜的是 JSON.stringify 返回 undefined 的情形（顶层是 undefined / 函数 / symbol）：
 * 三个调用点传的都是对象，实际走不到，留着是为了让返回类型是 string 而非 string | undefined。
 */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{"_unserializable":true}';
  }
}

/**
 * 按字符上限截断，并保证不切出半个代理对。
 *
 * slice 操作的是 UTF-16 码元，正好切在代理对中间会留下孤立高位代理项。
 * 实测 node:sqlite 不会因此报错，但写入时该码元被替换成 U+FFFD，读回来与原值不一致。
 */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let cut = value.slice(0, limit - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * 把工具参数裁剪为审计摘要。
 *
 * bash 保留完整命令——审计的主要价值就在于此，只在超过 MAX_COMMAND_LENGTH 时才截断。
 * 写类工具只留路径。其余工具整体序列化后按 MAX_DIGEST_LENGTH 截断，
 * 避免个别工具的大参数撑爆表。
 *
 * 返回值不保证是合法 JSON：截断发生在字符层面，尾部会留下半截字面量（以 … 标记）。
 * tool_audit.args 是给人看的取证字符串，只作展示，不要 JSON.parse 它。
 */
export function digestArgs(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '{}';
  // shell 不是 pi 的注册工具名，作为 bash 的别名兜底，防 agent 侧改名。
  if (tool === 'bash' || tool === 'shell') {
    const command = typeof args.command === 'string' ? args.command : '';
    return truncate(stringify({ command }), MAX_COMMAND_LENGTH);
  }
  if (PATH_ONLY_TOOLS.has(tool)) {
    // 键的清单必须与 extensions/safety/rules.ts 的 extractPath 严格一致（path / file_path /
    // filePath）。多认一个键会让「判的」与「记的」指向不同的东西：flags.protectedPath、
    // flags.outsideWorkspace 与 ToolCallFacts.path 都由 extractPath 算出，而审计的用途
    // 恰恰是复盘当时依据什么作了判断。两侧要扩展就一起扩展。
    const path = args.path ?? args.file_path ?? args.filePath;
    return stringify({ path: typeof path === 'string' ? path : '' });
  }
  return truncate(stringify(args), MAX_DIGEST_LENGTH);
}
