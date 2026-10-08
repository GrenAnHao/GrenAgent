import { parseInvocation, splitArgs } from '@extensions/prompt-commands/syntax';
import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';
import type { PiCommand } from '../commandTypes';
import { parseQuotedSkillToken } from '../../skillCommandText';
import type { ChatTagData } from './ChatTag/types';
import type { InsertCommandPillPayload } from './CommandPill/commands';

/**
 * 解析粘贴文本里开头的斜杠命令 token。
 *
 * 用于把「复制 `/goal` 粘贴进输入框」识别成命令，使其能像手动输入 `/` 选择那样
 * 转成命令标签。只认开头紧跟命令名的形态，避免把 `/usr/local/bin` 这类绝对路径、
 * `//` 注释误判成命令。
 *
 * 匹配规则：
 * - 去掉前导空白后必须以 `/` 开头；
 * - 命令名为 `[A-Za-z0-9_:-]+`（冒号用于 `skill:` 前缀命令）；
 * - 含空白的技能名写成 `/skill:"name"`，引号内整段都是名字；
 * - 命令名之后必须是字符串结尾或一个空白字符——`/foo/bar` 因第二段非空白开头被排除。
 *
 * 返回的 rest 已去除命令名与参数之间的前导空白；命令是否真实存在由调用方校验。
 */
export interface ParsedCommandToken {
  name: string;
  /** 命令名之后的剩余文本（参数），已去前导空白；无参数时为空串。 */
  rest: string;
}

const COMMAND_TOKEN = /^\/([A-Za-z0-9_:-]+)([\s\S]*)$/;

export function parseCommandToken(text: string): ParsedCommandToken | null {
  const quoted = parseQuotedSkillToken(text);
  if (quoted) return quoted;

  const match = text.trimStart().match(COMMAND_TOKEN);
  if (!match) return null;

  const rest = match[2];
  // 命令名后若紧跟非空白字符（如 `/foo/bar` 的 `/bar`），说明不是命令而是路径等。
  if (rest && !/^\s/.test(rest)) return null;

  return { name: match[1], rest: rest.replace(/^\s+/, '') };
}

/** 命令名去掉 `skill:` 前缀，作为标签上展示的短文本。 */
function commandLabel(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name;
}

/**
 * 把粘贴文本解析成命令标签数据。
 * 仅当开头是已加载的 api 命令时返回标签 payload（参数作为 trailingText）；
 * 非命令、未知命令、或前端即时命令（compact/newSession）返回 null，由调用方放行默认粘贴。
 */
export function resolveCommandTag(commands: PiCommand[], text: string): ChatTagData | null {
  const parsed = parseCommandToken(text);
  if (!parsed) return null;

  const command = commands.find((c) => c.name === parsed.name);
  if (!command || command.source === 'frontend') return null;

  return {
    category: 'command',
    label: commandLabel(command.name),
    value: command.name,
    commandGroup: command.apiSource ?? 'unknown',
    trailingText: parsed.rest || undefined,
  };
}

/** 粘贴 `/模板 参数…`：命中带参数的模板时返回胶囊数据，参数不够的位置留空串。 */
export function resolvePromptPill(templates: readonly PromptCommandInfo[], text: string): InsertCommandPillPayload | null {
  const invocation = parseInvocation(text.trim());
  if (!invocation) return null;
  const template = templates.find((item) => item.name === invocation.name && item.params.length > 0);
  if (!template) return null;
  const { args, rest } = splitArgs(invocation.argsText, template.params.length);
  return {
    name: template.name,
    params: template.params,
    values: template.params.map((_, index) => args[index] ?? ''),
    trailingText: rest || undefined,
  };
}
