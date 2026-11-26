import type { ChatMessage } from '../stores/agentReducer';
import { pathKey } from './pathUtils';
import { pi } from './pi';

/**
 * 从 pi 会话文件路径派生 UI 历史文件的稳定 key（basename 去扩展名）。
 * 与后端 `<workspace>/.pi/ui-history/<key>.jsonl` 对应；空/无路径返回 null。
 */
export function sessionKeyFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '').trim();
  return stem || null;
}

function historyMessage(message: ChatMessage): ChatMessage {
  if (message.kind !== 'tool' || message.argsComplete === undefined) return message;
  const { argsComplete, ...rest } = message;
  if (argsComplete === false) {
    return { ...rest, status: 'error', result: { content: [{ type: 'text', text: '已中断' }] } };
  }
  return rest;
}

/** 把前端完整消息列表序列化成 jsonl（每行一条 ChatMessage）。参数生成标记不落盘。 */
export function serializeHistory(messages: ChatMessage[]): string {
  return messages.map((m) => JSON.stringify(historyMessage(m))).join('\n');
}

interface HistoryCheckpoint {
  messages: ChatMessage[];
  /** End offset of each committed row, in UTF-8 bytes (not JS string length). */
  ends: number[];
  revision: string;
}

interface HistoryWriter {
  workspace: string;
  sessionKey: string;
  saved?: HistoryCheckpoint;
  latest?: ChatMessage[];
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
}

const writers = new Map<string, HistoryWriter>();
const encoder = new TextEncoder();
export const UI_HISTORY_BATCH_MS = 250;
const MAX_CHECKPOINTS = 30;

function writerKey(workspace: string, sessionPath: string): string {
  return JSON.stringify([pathKey(workspace), pathKey(sessionPath)]);
}

function writerFor(workspace: string, sessionPath: string): HistoryWriter | undefined {
  const sessionKey = sessionKeyFromPath(sessionPath);
  if (!sessionKey) return;
  const key = writerKey(workspace, sessionPath);
  const writer = writers.get(key) ?? { workspace, sessionKey };
  writers.delete(key);
  writers.set(key, writer);
  return writer;
}

function trimCheckpoints(): void {
  // Never evict a queued/in-flight save. Count only idle checkpoints, not active sessions.
  const idle = [...writers].filter(([, w]) => !w.latest && !w.inFlight);
  for (const [key, w] of idle) if (!w.saved) writers.delete(key);
  const checkpoints = idle.filter(([, w]) => w.saved);
  for (const [key] of checkpoints.slice(0, Math.max(0, checkpoints.length - MAX_CHECKPOINTS))) writers.delete(key);
}

async function persist(writer: HistoryWriter, messages: ChatMessage[], replace: boolean): Promise<void> {
  const { workspace, sessionKey } = writer;
  const saved = replace ? undefined : writer.saved;
  let sameRows = 0;
  while (saved && sameRows < messages.length && saved.messages[sameRows] === messages[sameRows]) sameRows += 1;
  if (saved && sameRows === messages.length && sameRows === saved.messages.length) return;

  const ends = saved?.ends.slice(0, sameRows) ?? [];
  const offset = ends.at(-1) ?? 0;
  let end = offset;
  const rows: string[] = [];
  for (let i = sameRows; i < messages.length; i += 1) {
    const row = JSON.stringify(historyMessage(messages[i]!));
    rows.push(row);
    end += (i > 0 ? 1 : 0) + encoder.encode(row).byteLength;
    ends.push(end);
  }
  // The common prefix is already on disk. Even on tail replacement it never crosses IPC.
  const tail = (offset && rows.length ? '\n' : '') + rows.join('\n');
  const revision = saved
    ? await pi.patchUiHistory(workspace, sessionKey, saved.revision, offset, tail)
    : await pi.writeUiHistory(workspace, sessionKey, tail, true);
  if (revision === null) {
    writer.saved = undefined;
    throw new Error('UI history changed before incremental save');
  }
  writer.saved = revision ? { messages, ends, revision } : undefined;
}

function cancelBatch(writer: HistoryWriter): void {
  clearTimeout(writer.timer);
  writer.timer = undefined;
  writer.latest = undefined;
}

function enqueue(writer: HistoryWriter, action: () => Promise<void>): Promise<void> {
  const previous = writer.inFlight;
  const operation = previous ? previous.catch(() => {}).then(action) : action();
  writer.inFlight = operation;
  const settled = () => {
    if (writer.inFlight !== operation) return;
    writer.inFlight = undefined;
    if (writer.latest && writer.timer === undefined) armBatch(writer);
    trimCheckpoints();
  };
  void operation.then(settled, settled);
  return operation;
}

function flushBatch(writer: HistoryWriter): Promise<void> | undefined {
  const messages = writer.latest;
  if (!messages) return writer.inFlight;
  cancelBatch(writer);
  return enqueue(writer, () => persist(writer, messages, false));
}

function armBatch(writer: HistoryWriter): void {
  writer.timer = setTimeout(() => {
    writer.timer = undefined;
    // Keep only the newest snapshot while disk I/O is busy, not a queue of snapshots.
    if (!writer.inFlight) void flushBatch(writer)?.catch(() => {});
  }, UI_HISTORY_BATCH_MS);
}

/** Live stream: coalesce message boundaries per session and save only changed rows. */
export function scheduleUiHistory(workspace: string, sessionPath: string, messages: ChatMessage[]): void {
  const writer = writerFor(workspace, sessionPath);
  if (!writer) return;
  writer.latest = messages;
  if (writer.timer === undefined) armBatch(writer);
}

/** Explicit seed/replacement (cold load, migration metadata, or truncation). */
export async function replaceUiHistory(workspace: string, sessionPath: string, messages: ChatMessage[]): Promise<void> {
  const writer = writerFor(workspace, sessionPath);
  if (!writer) return;
  cancelBatch(writer);
  await enqueue(writer, () => persist(writer, messages, true));
}

/** Cancel unsent snapshots before deleting so a delayed batch cannot resurrect history. */
export async function deleteUiHistoryForSession(workspace: string, sessionPath: string): Promise<void> {
  const writer = writerFor(workspace, sessionPath);
  if (!writer) return;
  cancelBatch(writer);
  await enqueue(writer, async () => {
    writer.saved = undefined;
    await pi.deleteUiHistory(workspace, writer.sessionKey);
  });
}

/**
 * 从 jsonl 还原消息列表；逐行 parse，坏行跳过（fail-soft）。
 * id 重新分配（`h-<n>`）：存盘的旧 id 与运行时 nextId 数字 id 可能撞号，重排规避（对齐 messagesFromTranscript）。
 */
export function deserializeHistory(jsonl: string, ends?: number[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  let offset = 0;
  for (const line of jsonl.split('\n')) {
    if (ends) offset += encoder.encode(line).byteLength;
    const s = line.trim();
    if (s) {
      try {
        const m = JSON.parse(s) as ChatMessage;
        out.push({ ...m, id: `h-${i}` } as ChatMessage);
        ends?.push(offset);
        i += 1;
      } catch {
        // 坏行跳过：最坏情况少一条历史，不影响其余渲染。
      }
    }
    offset += 1;
  }
  return out;
}

/** 从磁盘读某会话的 UI 完整历史；无文件/空/失败返回 undefined（调用方走后端 getMessages）。 */
export async function readUiHistoryForSession(
  workspace: string,
  sessionPath: string | null | undefined,
): Promise<ChatMessage[] | undefined> {
  const key = sessionKeyFromPath(sessionPath);
  if (!key) return undefined;
  try {
    const id = writerKey(workspace, sessionPath!);
    const writer = writers.get(id);
    if (writer) await flushBatch(writer)?.catch(() => {});
    const result = await pi.readUiHistory(workspace, key, !writer?.saved);
    const raw = typeof result === 'string' ? result : result.content;
    if (!raw.trim()) return undefined;
    const revision = typeof result === 'string' ? undefined : result.revision;
    const ends = revision ? [] as number[] : undefined;
    const msgs = deserializeHistory(raw, ends);
    // Reuse the disk checkpoint only if no concurrent writer has already established one.
    const current = writers.get(id);
    if (revision && ends && msgs.length && !current?.saved && !current?.inFlight && !current?.latest && (writer === current || !current)) {
      const seeded = writerFor(workspace, sessionPath!)!;
      seeded.saved = { messages: msgs, ends, revision };
      trimCheckpoints();
    }
    return msgs.length > 0 ? msgs : undefined;
  } catch {
    return undefined;
  }
}
