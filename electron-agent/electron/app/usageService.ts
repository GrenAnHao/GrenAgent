import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageReport } from '../../src/lib/usageReport';
import { callFromMessage, defaultLedgerPath, sharedLedger, type UsageLedger } from '../../../extensions/usage-ledger/ledger.js';
import { firstLineOf, forEachLineContaining } from './sessionLineScan';

// Note: 账本取代扫描的取舍见 .agents/notes/implemented/architecture/2026-10-21-usage-ledger.md
//
// 用量报表来自账本（extensions/usage-ledger 在每次模型调用结束时记账），这里只做两件事：
// 1. report：账本还没导入过历史时先导入一次，之后每次都是纯 SQL 聚合。
// 2. reconcile：用户手动「补录」，把会话目录里账本没有的调用补进来（命令行 pi、记账上线之前的会话）。
// 运行在 agent-host 子进程：同步 sqlite 和导入时的解析都不占主进程。

/** 历史导入的版本；导入口径变了就加一，下次打开用量页会重新补录一遍（按键去重，不会重复计数）。 */
const IMPORT_VERSION = '1';
const IMPORT_META_KEY = 'import_version';
/** 同时在读 / 解析的会话文件数。 */
const SCAN_CONCURRENCY = 4;

export interface ImportResult {
  files: number;
  added: number;
}

export class UsageService {
  private readonly ledger: UsageLedger;
  private importing: Promise<ImportResult> | null = null;

  constructor(private readonly agentDir: string, options: { ledger?: UsageLedger } = {}) {
    this.ledger = options.ledger ?? sharedLedger(defaultLedgerPath(agentDir));
  }

  async report(): Promise<UsageReport> {
    if (this.ledger.getMeta(IMPORT_META_KEY) !== IMPORT_VERSION) await this.reconcile();
    return this.ledger.report();
  }

  /** 扫一遍会话目录，把账本里没有的调用补进去。同时来的几次共用一次扫描。 */
  reconcile(): Promise<ImportResult> {
    this.importing ??= this.importSessions().finally(() => { this.importing = null; });
    return this.importing;
  }

  private async importSessions(): Promise<ImportResult> {
    const paths = await collectJsonl(join(this.agentDir, 'sessions'));
    let added = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++];
        let buffer: Buffer;
        try { buffer = await readFile(path); } catch { continue; }
        added += this.importFile(path, buffer);
        // 解析是同步的，每个文件之间回到事件循环，别让 agent-host 的会话事件排队太久。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    this.ledger.setMeta(IMPORT_META_KEY, IMPORT_VERSION);
    return { files: paths.length, added };
  }

  /** 一个会话文件：只解码含标记的行（工具结果这类大行不转字符串、不 JSON.parse）。 */
  private importFile(path: string, buffer: Buffer): number {
    const header = parse(firstLineOf(buffer));
    if (header?.type !== 'session' || typeof header.id !== 'string') return 0;
    const sessionId = header.id;
    const headerTimestamp = text(header.timestamp);
    let name = text(header.name)?.trim() || null;
    // JSON 字符串里的引号会转义成 \"，"session_info" / "usage" 只会以结构形式出现；误中只多一次解析。
    forEachLineContaining(buffer, '"session_info"', (line) => {
      const entry = parse(line);
      const value = entry?.type === 'session_info' ? text(entry.name)?.trim() : undefined;
      if (value) name = value;
    });
    const calls: NonNullable<ReturnType<typeof callFromMessage>>[] = [];
    forEachLineContaining(buffer, '"usage"', (line) => {
      if (!line.includes('"assistant"')) return;
      const entry = parse(line);
      if (entry?.type !== 'message') return;
      const call = callFromMessage(entry.message, sessionId, text(entry.timestamp) ?? headerTimestamp);
      if (call) calls.push({ ...call, entryId: text(entry.id) });
    });
    return this.ledger.transaction(() => {
      this.ledger.upsertSession({ id: sessionId, path, cwd: text(header.cwd), startedAt: headerTimestamp, name });
      let added = 0;
      for (const call of calls) if (this.ledger.record(call, 'import')) added += 1;
      return added;
    });
  }
}

async function collectJsonl(directory: string): Promise<string[]> { try { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map((entry) => entry.isDirectory() ? collectJsonl(join(directory, entry.name)) : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : []))).flat(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
function parse(line: string): Record<string, unknown> | null { try { const value = JSON.parse(line) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
