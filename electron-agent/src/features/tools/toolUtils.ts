import type { LucideIcon } from 'lucide-react';
import {
  FilePen,
  FilePlus,
  FileText,
  Folder,
  Globe,
  Image,
  ListChecks,
  Network,
  Search,
  Terminal,
  Volume2,
  Wrench,
} from 'lucide-react';

const MAX_ARG_VALUE_LEN = 50;

export function extractText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);

  const obj = result as Record<string, unknown>;
  if (typeof obj.content === 'string') return obj.content;

  if (Array.isArray(obj.content)) {
    return obj.content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export function getDiff(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return undefined;
  const diff = (details as Record<string, unknown>).diff;
  return typeof diff === 'string' && diff.trim() ? diff : undefined;
}

/**
 * 「上下文收集」工具：只读地读取文件/列目录。时间线里连续的此类调用折叠成一条摘要
 *（对齐 MiMo 的 ContextToolGroup）。grep/glob 不在此列——它们作为「搜索动作」
 * 各自独立成 Cursor 风格的结果卡常驻可见；edit/write/bash 等动作工具同样逐个单独展示。
 */
const CONTEXT_TOOLS = new Set(['read', 'read_file', 'ls', 'list_dir']);

export function isContextTool(toolName: string): boolean {
  return CONTEXT_TOOLS.has(toolName.toLowerCase());
}

/** 上下文工具归类（用于折叠摘要计数）：read=读文件，list=列目录。 */
export function contextToolCategory(toolName: string): 'read' | 'list' {
  const name = toolName.toLowerCase();
  if (name === 'ls' || name === 'list_dir') return 'list';
  return 'read';
}

/**
 * 识别「模型自主调用技能」：pi 没有专门的 skill 工具，模型是用 read 去读技能目录下的
 * SKILL.md 来加载技能内容的（progressive disclosure）。命中时返回技能名（取 SKILL.md
 * 所在目录名），否则 undefined。用于把这类读取从「上下文收集」折叠里拎出来、单独渲染成技能调用。
 */
export function skillNameFromRead(toolName: string, args: unknown): string | undefined {
  const name = toolName.toLowerCase();
  if (name !== 'read' && name !== 'read_file') return undefined;
  const path = getArgString(args, 'path');
  if (!path) return undefined;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts[parts.length - 1]?.toLowerCase() !== 'skill.md') return undefined;
  return parts[parts.length - 2] || undefined;
}

export function toolMeta(toolName: string): { icon: LucideIcon } {
  const name = toolName.toLowerCase();
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
    return { icon: Terminal };
  }
  if (name === 'read' || name === 'read_file') return { icon: FileText };
  if (name === 'write' || name === 'write_file') return { icon: FilePlus };
  if (name === 'edit' || name === 'search_replace' || name === 'str_replace') {
    return { icon: FilePen };
  }
  if (name === 'glob' || name === 'grep' || name === 'ripgrep') return { icon: Search };
  if (name === 'ls' || name === 'list_dir') return { icon: Folder };
  // —— extension tools ——
  if (name === 'generate_image') return { icon: Image };
  if (name === 'spawn_agent') return { icon: Network };
  if (name === 'fetch_url') return { icon: Globe };
  if (name === 'fetch_llms') return { icon: FileText };
  if (name === 'web_search' || name === 'search') return { icon: Search };
  if (name.startsWith('fetch_')) return { icon: Globe };
  if (name === 'speak') return { icon: Volume2 };
  if (name === 'todo') return { icon: ListChecks };
  return { icon: Wrench };
}

function truncateValue(value: string, max = MAX_ARG_VALUE_LEN): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function formatArgValue(value: unknown): string {
  if (typeof value === 'string') return truncateValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncateValue(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function argSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';
  const [key, value] = entries[0];
  return `${key}: ${formatArgValue(value)}`;
}

export function langByPath(path: unknown): string {
  if (typeof path !== 'string') return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'bash',
    bash: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
    sql: 'sql',
    diff: 'diff',
  };
  return map[ext] ?? 'plaintext';
}

export function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
}

export function stringifyJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getArgString(args: unknown, key: string): string {
  if (!args || typeof args !== 'object') return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : value != null ? formatArgValue(value) : '';
}

export function getEditTexts(args: unknown): { oldText: string; newText: string } {
  if (!args || typeof args !== 'object') return { oldText: '', newText: '' };
  const input = args as Record<string, unknown>;
  const pairs = (Array.isArray(input.edits) ? input.edits : []).flatMap((edit) => {
    if (!edit || typeof edit !== 'object') return [];
    const pair = edit as Record<string, unknown>;
    return typeof pair.oldText === 'string' && typeof pair.newText === 'string'
      ? [{ oldText: pair.oldText, newText: pair.newText }]
      : [];
  });
  if (pairs.length) {
    return {
      oldText: pairs.map((pair) => pair.oldText).join('\n...\n'),
      newText: pairs.map((pair) => pair.newText).join('\n...\n'),
    };
  }
  return {
    oldText: typeof input.oldText === 'string' ? input.oldText : typeof input.old_string === 'string' ? input.old_string : '',
    newText: typeof input.newText === 'string' ? input.newText : typeof input.new_string === 'string' ? input.new_string : '',
  };
}

export function getDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return undefined;
  return details as Record<string, unknown>;
}
