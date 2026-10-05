/**
 * 技能命令的线上形态。
 * Pi 把 `/skill:` 后第一个空格前的内容当作技能名，气泡解析同样按非空白截断。
 * 名字里有空白或引号时写成 `/skill:"name"`，名字和后面的参数才能分开。
 */

const QUOTED_NAME = /^"((?:\\.|[^"\\])*)"([\s\S]*)$/;

export function unescapeSkillName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** 命令标签的 value。普通命令原样返回；需要引号的技能名变成 `skill:"name"`。 */
export function formatCommandValue(value: string): string {
  if (!value.startsWith('skill:')) return value;
  const name = value.slice('skill:'.length);
  if (!name || !/[\s"]/.test(name)) return value;
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `skill:"${escaped}"`;
}

export type SkillCommandSplit =
  | { kind: 'quoted'; name: string; args: string }
  | { kind: 'bare'; body: string };

/** 整段文本以 `/skill:` 开头时拆出调用。引号没闭合时返回 null。 */
export function splitSkillCommand(text: string): SkillCommandSplit | null {
  if (!text.startsWith('/skill:')) return null;
  const rest = text.slice('/skill:'.length);
  if (!rest.startsWith('"')) return { kind: 'bare', body: rest };
  const match = QUOTED_NAME.exec(rest);
  if (!match) return null;
  const after = match[2] ?? '';
  return {
    kind: 'quoted',
    name: unescapeSkillName(match[1] ?? ''),
    args: after.replace(/^\s+/, ''),
  };
}

/** 粘贴用：只认带引号的 `/skill:"name"`，名字还原成 `skill:name`。 */
export function parseQuotedSkillToken(text: string): { name: string; rest: string } | null {
  const split = splitSkillCommand(text.trimStart());
  if (!split || split.kind !== 'quoted') return null;
  return { name: `skill:${split.name}`, rest: split.args };
}
