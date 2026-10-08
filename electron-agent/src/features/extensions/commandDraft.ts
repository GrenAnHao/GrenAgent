import { COMMAND_NAME_RE } from '@extensions/prompt-commands/syntax';

export interface CommandDraft {
  originalName?: string;
  name: string;
  description: string;
  body: string;
}

export const EMPTY_COMMAND_DRAFT: CommandDraft = { name: '', description: '', body: '' };

/** 编辑区就地报错用；主进程保存时还会再校验一遍。 */
export function validateCommandDraft(
  draft: CommandDraft,
  reserved: ReadonlySet<string>,
  existing: ReadonlySet<string>,
): string | null {
  const name = draft.name.trim();
  if (!name) return '命令名不能为空';
  if (!COMMAND_NAME_RE.test(name)) return '命令名只能用字母、数字、中文、- 和 _，最长 64 个字符';
  if (reserved.has(name)) return `/${name} 和已有的内置、扩展或技能命令重名`;
  if (name !== draft.originalName && existing.has(name)) return `命令 /${name} 已存在`;
  if (!draft.body.trim()) return '提示词不能为空';
  return null;
}
