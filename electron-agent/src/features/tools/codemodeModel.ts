import type { ToolSegment } from '../chat/groupMessages';
import { parsePartialArgs } from '../../lib/streamingJson';
import { formatRunDuration } from './bashCardModel';
import { getDetails } from './toolUtils';

/**
 * 官方 codemode 工具（pi-coding-agent extensions/codemode）的结果解析，供工具卡渲染。
 *
 * 结果形状（execute.js）：
 * - content[0] 是 `Script completed|failed\nWall time N seconds\nOutput:\n` 头，后面是脚本输出。
 *   1.1.0 起相邻文本并成一块（图片把它隔开）：多个 text() / return 值各以 `==> text N/M <==` 行开头，
 *   console.* 收进末尾的 `<console_output>` 块，失败时再接 `Script error:\n`。
 *   1.0.2 的历史会话里每项各占一块，console 行不带标签。
 * - details.calls 是嵌套调用记录：`{ id, name, args(JSON 预览 ≤200 字), status, durationMs?, error?, cost? }`。
 *   运行中 id 是 `<父id>/?`，完成后换成嵌套调用真实的 toolCallId。
 * 实时会话里嵌套调用另有带 parentToolCallId 的 tool_execution_* 事件（有完整参数和结果）；
 * 切回会话时只剩 details.calls。两路按 mergeCodemodeCalls 合成一张列表。
 */

export function isCodemodeTool(toolName: string): boolean {
  return toolName.toLowerCase() === 'codemode';
}

export type CodemodeCallStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface CodemodeCall {
  id: string;
  name: string;
  /** JSON 预览，超长时被 pi 截成 `...` 结尾。 */
  args: string;
  status: CodemodeCallStatus;
  durationMs?: number;
  error?: string;
  cost?: number;
}

const CALL_STATUSES = new Set<CodemodeCallStatus>(['running', 'ok', 'error', 'cancelled']);

export function codemodeCalls(result: unknown): CodemodeCall[] {
  const raw = getDetails(result)?.calls;
  if (!Array.isArray(raw)) return [];
  const out: CodemodeCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    if (typeof call.name !== 'string' || !call.name) continue;
    const status = CALL_STATUSES.has(call.status as CodemodeCallStatus) ? (call.status as CodemodeCallStatus) : 'running';
    out.push({
      id: typeof call.id === 'string' ? call.id : '',
      name: call.name,
      args: typeof call.args === 'string' ? call.args : '',
      status,
      ...(typeof call.durationMs === 'number' ? { durationMs: call.durationMs } : {}),
      ...(typeof call.error === 'string' && call.error ? { error: call.error } : {}),
      ...(typeof call.cost === 'number' && call.cost > 0 ? { cost: call.cost } : {}),
    });
  }
  return out;
}

export type CodemodeCallItem =
  | {
      kind: 'live';
      key: string;
      status: CodemodeCallStatus;
      name: string;
      segment: ToolSegment;
      /** 配上的记录里 pi 量的耗时，比渲染层按事件到达时刻算的准。 */
      durationMs?: number;
    }
  | { kind: 'record'; key: string; status: CodemodeCallStatus; name: string; call: CodemodeCall };

function liveStatus(segment: ToolSegment): CodemodeCallStatus {
  return segment.status === 'done' ? 'ok' : segment.status;
}

/**
 * 按 details.calls 的顺序把记录和实时嵌套段配成一张列表：
 * - id 对得上的用实时段（能展开看完整参数和结果）；
 * - 运行中的 `<父id>/?` 记录，配同名、还没被别的记录占用的实时段；
 * - 配不上的记录（历史回放、models.* 调用）原样成行；
 * - 记录里还没出现的实时段排在最后（进度更新比嵌套事件晚一拍时）。
 */
export function mergeCodemodeCalls(records: CodemodeCall[], children: ToolSegment[] = []): CodemodeCallItem[] {
  const byId = new Map(children.map((child) => [child.toolCallId, child]));
  const recordIds = new Set(records.map((record) => record.id));
  const used = new Set<string>();
  const out: CodemodeCallItem[] = [];
  records.forEach((call, index) => {
    let child = byId.get(call.id);
    if (child && used.has(child.toolCallId)) child = undefined;
    if (!child && call.id.endsWith('/?')) {
      child = children.find(
        (candidate) => !used.has(candidate.toolCallId) && !recordIds.has(candidate.toolCallId) && candidate.toolName === call.name,
      );
    }
    if (child) {
      used.add(child.toolCallId);
      out.push({
        kind: 'live',
        key: child.id,
        status: liveStatus(child),
        name: child.toolName,
        segment: child,
        ...(call.durationMs != null ? { durationMs: call.durationMs } : {}),
      });
    } else {
      out.push({ kind: 'record', key: `${call.id || call.name}#${index}`, status: call.status, name: call.name, call });
    }
  });
  for (const child of children) {
    if (used.has(child.toolCallId)) continue;
    out.push({ kind: 'live', key: child.id, status: liveStatus(child), name: child.toolName, segment: child });
  }
  return out;
}

/** `mcp__<server>__<tool>` 拆成服务器和工具名；不是 MCP 工具返回 null。 */
export function mcpToolParts(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

export function isMcpTool(name: string): boolean {
  return mcpToolParts(name) != null;
}

/** 列表和标题里的调用名：MCP 工具读作 `server.tool`。 */
export function callLabel(name: string): string {
  const parts = mcpToolParts(name);
  return parts ? `${parts.server}.${parts.tool}` : name;
}

/** 标题摘要：去重后的调用名，重复的带 ×N。 */
export function codemodeCallSummary(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const label = callLabel(name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join('、');
}

/** 还没有调用时，标题用脚本第一行有内容的代码（跳过空行和 `// @options:`）。 */
export function firstCodeLine(code: string): string {
  for (const line of code.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('// @options:')) continue;
    return trimmed;
  }
  return '';
}

export function codemodeCode(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const code = (args as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** 嵌套调用耗时：不到 1 秒记毫秒，不到 1 分钟保留一位小数，再长交给 formatRunDuration。 */
export function formatCallDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatRunDuration(ms);
}

const ARG_PART_MAX = 2;

function arrayPart(items: unknown[]): string {
  if (items.length === 0) return '';
  const first = items[0];
  let head = '';
  if (typeof first === 'string') head = first;
  else if (first && typeof first === 'object') {
    const value = Object.values(first as Record<string, unknown>).find((v) => typeof v === 'string' && v.trim());
    head = typeof value === 'string' ? value : '';
  }
  if (!head) return `${items.length} 项`;
  return items.length > 1 ? `${head} 等 ${items.length} 项` : head;
}

/**
 * 调用参数读成人话：按书写顺序取前两个有内容的值（字符串原样，数组取首项 + 项数），
 * 用于 MCP 等通用工具。参数是 pi 截断过的 JSON 预览时按半截 JSON 解析。
 */
export function toolArgsSummary(args: unknown): string {
  let value = args;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (!text.startsWith('{')) return text;
    const parsed = parsePartialArgs(text.endsWith('...') ? text.slice(0, -3) : text);
    if (Object.keys(parsed).length === 0) return text;
    value = parsed;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (parts.length >= ARG_PART_MAX) break;
    if (typeof raw === 'string') {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      parts.push(`${key}=${raw}`);
    } else if (Array.isArray(raw)) {
      const part = arrayPart(raw);
      if (part) parts.push(part);
    }
  }
  return parts.join(' · ');
}

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;
const SCRIPT_ERROR = /(?:^|\n)Script error:\n/;
const TEXT_MARKER = /^==> text (\d+)\/(\d+) <==$/;
const CONSOLE_OPEN = '<console_output>\n';
const CONSOLE_CLOSE = '\n</console_output>';
const IMAGES_NOTE = /(?:^|\n)(Note: models\.generateImages\(\) returned [^\n]*)\s*$/;

export type CodemodeOutputBlock =
  | { kind: 'text'; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'console'; text: string }
  | { kind: 'error'; text: string };

export interface CodemodeOutput {
  /** 有结果头时才有：脚本是否跑完。 */
  ok?: boolean;
  wallMs?: number;
  blocks: CodemodeOutputBlock[];
  fullOutputPath?: string;
}

/** 整块是 JSON 对象 / 数组时返回缩进后的文本，否则 undefined。 */
export function prettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object') return undefined;
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/** 多个 text 项各以 `==> text N/M <==` 开头；块首行必须是标记，之后只认总数 M 相同的标记行。 */
function splitTextItems(text: string): string[] {
  const lines = text.split('\n');
  const first = TEXT_MARKER.exec(lines[0]!);
  if (!first) return [text];
  const items: string[][] = [];
  for (const line of lines) {
    const marker = TEXT_MARKER.exec(line);
    if (marker && marker[2] === first[2]) items.push([]);
    else items[items.length - 1]!.push(line);
  }
  return items.map((item) => item.join('\n'));
}

function textOrJson(text: string): CodemodeOutputBlock | undefined {
  const json = prettyJson(text);
  if (json) return { kind: 'json', text: json };
  return text.trim() ? { kind: 'text', text } : undefined;
}

/**
 * 一个文本块拆回各项。1.1.0 把相邻文本并成一块，依次是：text 项、`<console_output>` 块、
 * `Script error:`（只在失败时出现）、未展示图片的提示。1.0.2 每项各占一块，整块原样分类。
 */
function splitOutputText(text: string, failed: boolean): CodemodeOutputBlock[] {
  let rest = text;
  const tail: CodemodeOutputBlock[] = [];
  const note = IMAGES_NOTE.exec(rest);
  if (note) {
    tail.push({ kind: 'text', text: note[1]! });
    rest = rest.slice(0, note.index);
  }
  const error = failed ? SCRIPT_ERROR.exec(rest) : null;
  if (error) {
    tail.unshift({ kind: 'error', text: rest.slice(error.index + error[0].length).trim() });
    rest = rest.slice(0, error.index);
  }
  rest = rest.replace(/\s+$/, '');
  const open = rest.lastIndexOf(CONSOLE_OPEN);
  if (open >= 0 && (open === 0 || rest[open - 1] === '\n') && rest.endsWith(CONSOLE_CLOSE)) {
    tail.unshift({ kind: 'console', text: rest.slice(open + CONSOLE_OPEN.length, -CONSOLE_CLOSE.length) });
    rest = rest.slice(0, open);
  }
  const items = rest.trim() ? splitTextItems(rest.replace(/\n$/, '')) : [];
  return [...items.map(textOrJson).filter((block) => block != null), ...tail];
}

/** 去掉结果头，拆成文本 / JSON / 控制台 / 脚本错误；相邻文本合并。图片块交给 extractContentImages。 */
export function parseCodemodeOutput(result: unknown): CodemodeOutput {
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined;
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') texts.push(block);
      else if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') texts.push(text);
      }
    }
  }
  const out: CodemodeOutput = { blocks: [] };
  const header = texts.length > 0 ? SCRIPT_HEADER.exec(texts[0]!) : null;
  if (header) {
    out.ok = header[1] === 'completed';
    const seconds = Number(header[2]);
    if (Number.isFinite(seconds)) out.wallMs = seconds * 1000;
    texts.shift();
  }
  for (const text of texts) {
    for (const block of splitOutputText(text, out.ok !== true)) {
      const last = out.blocks[out.blocks.length - 1];
      if (block.kind === 'text' && last?.kind === 'text') last.text = `${last.text}\n${block.text}`;
      else out.blocks.push(block);
    }
  }
  const fullOutputPath = getDetails(result)?.fullOutputPath;
  if (typeof fullOutputPath === 'string' && fullOutputPath) out.fullOutputPath = fullOutputPath;
  return out;
}

const FULL_OUTPUT_TAIL = /\n?全文: ([^\n]+?)\s*$/;

/** MCP 结果正文末尾的 `全文: <临时文件>`（extensions/mcp/resultShape.ts）拆出来单独显示。 */
export function splitFullOutput(text: string): { body: string; fullPath?: string } {
  const match = FULL_OUTPUT_TAIL.exec(text);
  if (!match) return { body: text };
  return { body: text.slice(0, match.index), fullPath: match[1] };
}

const MARKDOWN_SIGNALS = [
  /^#{1,6}\s+\S/m,
  /^```/m,
  /^\s*[-*+]\s+\S/m,
  /^\s*\d+\.\s+\S/m,
  /^\|.+\|\s*$/m,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /\*\*[^*\n]+\*\*/,
];

export type ResultFormat = 'json' | 'markdown' | 'text';

export function detectResultFormat(text: string): ResultFormat {
  if (prettyJson(text)) return 'json';
  return MARKDOWN_SIGNALS.some((pattern) => pattern.test(text)) ? 'markdown' : 'text';
}
