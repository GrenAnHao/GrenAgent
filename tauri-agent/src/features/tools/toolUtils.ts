import type { LucideIcon } from 'lucide-react';
import {
  BookPlus,
  Brain,
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
  if (name === 'kb_search') return { icon: Search };
  if (name === 'kb_add') return { icon: BookPlus };
  if (name === 'memory_save' || name === 'memory_recall') return { icon: Brain };
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

export function getDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return undefined;
  return details as Record<string, unknown>;
}
