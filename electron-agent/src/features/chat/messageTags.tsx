import { findCommandBlocks, parseInvocation, resolveArgs, splitArgs } from '@extensions/prompt-commands/syntax';
import type { ReactNode } from 'react';
import { openBrowserPopupTab } from '../dock/browser/openBrowserPopupTab';
import { ChatTagView } from './input/editor/ChatTag/ChatTagView';
import { CommandPillView } from './input/editor/CommandPill/CommandPillView';
import { getCachedPromptCommands } from './input/editor/promptCommandCache';
import { formatUrlLabel } from './input/editor/urlPaste';
import { unescapeSkillName } from './skillCommandText';

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string }
  | { type: 'skill'; name: string }
  | { type: 'link'; url: string }
  | { type: 'command'; name: string; args: Array<{ name: string; value: string }> };

// Pi expands a `/skill:<name>` command into the full SKILL.md wrapped in
// `<skill name="..." location="...">...</skill>`. The optimistic (just-sent)
// message still carries the short `/skill:<name>` text. Collapse BOTH forms to a
// compact skill chip so the bubble stays consistent before and after a reload
// (no more "wall of SKILL.md text" when switching back to a conversation).
const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;
// 两条分支：
// 1. `<url>` markdown autolink —— 尖括号自成边界（可紧跟文本），m[1] 为链接，渲染时隐藏两侧尖括号。
// 2. `(^|\s)` 边界后的裸 URL / `/skill:"name"` / `/skill:name` / `@path`。
//    m[2]=边界、m[3]=token、m[4]=引号内技能名、m[5]=无引号技能名、m[6]=file。
//    带空格的技能名必须走引号分支，否则会在第一个空格处截断。
const INLINE_RE = /<(https?:\/\/[^>\s]+)>|(^|\s)(https?:\/\/\S+|\/skill:"((?:\\.|[^"\\])*)"|\/skill:(\S+)|@(\S+))/g;

function bareSkillName(name: string): string {
  const n = name.trim();
  return n.startsWith('skill:') ? n.slice(6) : n;
}

/** Inline pass over a plain run: split out `<url>` autolinks, bare URLs, `/skill:name` and `@path` tokens. */
function parseInline(text: string, segments: MessageSegment[]): void {
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m[1] !== undefined) {
      // `<url>` autolink：尖括号从 m.index 起，不属于任何段（隐藏）。
      if (m.index > last) segments.push({ type: 'text', text: text.slice(last, m.index) });
      segments.push({ type: 'link', url: m[1] });
      last = INLINE_RE.lastIndex;
      continue;
    }
    const tokenStart = m.index + m[2].length;
    if (tokenStart > last) segments.push({ type: 'text', text: text.slice(last, tokenStart) });
    if (m[4] !== undefined) {
      segments.push({ type: 'skill', name: bareSkillName(unescapeSkillName(m[4])) });
    } else if (m[5] !== undefined) {
      segments.push({ type: 'skill', name: bareSkillName(m[5]) });
    } else if (m[6] !== undefined) {
      segments.push({ type: 'file', path: m[6] });
    } else {
      segments.push({ type: 'link', url: m[3] });
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
}

/**
 * 把一段不含 command 块的文本切成普通文本段、技能段（`/skill:` 或展开后的 `<skill>` 块）与文件引用段。
 * 文件引用沿用 messenger 的 `@相对路径` 约定：只匹配「行首或空白后的 @ + 非空白串」，
 * 借此避开 email（a@b.com，@ 前是字母）这类误命中。
 */
function parseSkillAndInline(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SKILL_BLOCK_RE.lastIndex = 0;
  while ((m = SKILL_BLOCK_RE.exec(text)) !== null) {
    if (m.index > last) parseInline(text.slice(last, m.index), segments);
    segments.push({ type: 'skill', name: bareSkillName(m[1]) });
    last = SKILL_BLOCK_RE.lastIndex;
  }
  if (last < text.length) parseInline(text.slice(last), segments);
  return segments;
}

/** 刚发出去、还没被 <command> 块替换的 `/模板 "参数"…`：用缓存的模板定义还原成胶囊。 */
function parseOptimisticCommand(text: string, segments: MessageSegment[]): string {
  const invocation = parseInvocation(text);
  if (!invocation) return text;
  const template = getCachedPromptCommands().find((item) => item.name === invocation.name && item.params.length > 0);
  if (!template) return text;
  const { args, rest } = splitArgs(invocation.argsText, template.params.length);
  const { values } = resolveArgs(template.params, args);
  segments.push({
    type: 'command',
    name: template.name,
    args: template.params.map((param) => ({ name: param.name, value: values[param.name] ?? '' })),
  });
  return rest ? ` ${rest}` : '';
}

/**
 * 把用户消息文本切成普通文本、命令胶囊（<command> 块或刚发出的调用文本）、
 * 技能段（`/skill:` 或展开后的 `<skill>` 块）与文件引用段。
 */
export function parseMessageTags(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  for (const hit of findCommandBlocks(text)) {
    if (!hit.block) continue;
    if (hit.start > last) segments.push(...parseSkillAndInline(text.slice(last, hit.start)));
    segments.push({ type: 'command', name: hit.block.name, args: hit.block.args });
    last = hit.end;
    // 块后的空行在 pre-wrap 气泡里会空出一行，压成一个空格，和输入框里一致。
    while (text.startsWith('\n', last)) last += 1;
    if (last < text.length && last > hit.end) segments.push({ type: 'text', text: ' ' });
  }
  const tail = text.slice(last);
  const remaining = last === 0 ? parseOptimisticCommand(tail, segments) : tail;
  if (remaining) segments.push(...parseSkillAndInline(remaining));
  return segments;
}

/**
 * 消息里文件 chip 的显示名。拖入的区外文件复制在 `.pi/dropped/<hash>/` 下，哈希目录对人没有意义，
 * 只显示文件名；其它路径原样显示。完整路径在悬停提示里。
 */
export function fileTagLabel(path: string): string {
  if (!path.startsWith('.pi/dropped/')) return path;
  return path.split('/').pop() || path;
}

/**
 * 渲染用户消息：`@相对路径` → 文件标签 chip；`/skill:名称` 或展开后的 `<skill>` 块 →
 * 技能命令 chip（与输入框/slash 菜单一致），其余按纯文本（保留换行）输出。
 */
export function renderMessageTags(text: string): ReactNode {
  return parseMessageTags(text).map((seg, i) => {
    if (seg.type === 'command') {
      return <CommandPillView key={i} name={seg.name} args={seg.args} />;
    }
    if (seg.type === 'file') {
      return <ChatTagView key={i} category="file" label={fileTagLabel(seg.path)} value={seg.path} />;
    }
    if (seg.type === 'skill') {
      return (
        <ChatTagView key={i} category="command" commandGroup="skill" label={seg.name} value={`skill:${seg.name}`} />
      );
    }
    if (seg.type === 'link') {
      return (
        <ChatTagView
          key={i}
          category="link"
          label={formatUrlLabel(seg.url)}
          value={seg.url}
          onOpen={() => openBrowserPopupTab({ url: seg.url, disposition: 'new-window' })}
        />
      );
    }
    return <span key={i}>{seg.text}</span>;
  });
}
