import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CallQuery, UsageFilters, UsageReport } from '../../src/lib/usageReport';
import { callFromMessage, callKey, warmFromEntry, warmKey, defaultLedgerPath, sharedLedger, type UsageLedger } from '../../../extensions/usage-ledger/ledger.js';
import { ensureLegacyRoster } from '../../../extensions/usage-ledger/legacyRoster.js';
import { UsageOriginRegistry, defaultOriginRegistryPath } from '../../../extensions/usage-ledger/originRegistry.js';
import { firstLineOf, forEachLineContaining } from './sessionLineScan';
import {
  SessionOperationLeaseBlockedError,
  SessionOperationLeaseBusyError,
  withSessionOperationLease,
} from './sessionOperationLease';

// Note: 账本取代扫描的取舍见 .agents/notes/implemented/architecture/2026-10-21-usage-ledger.md
//
// 用量报表来自账本（extensions/usage-ledger 在每次模型调用结束时记账），这里只做两件事：
// 1. report：账本还没导入过历史时先导入一次，之后筛选与汇总只读账本及其汇总表。
// 2. reconcile：用户手动「补录」，把会话目录里账本没有的调用补进来（命令行 pi、记账上线之前的会话）。
// 运行在 agent-host 子进程：同步 sqlite 和导入时的解析都不占主进程。

/** 历史导入的版本；导入口径变了就加一，下次打开用量页会重新补录一遍（按键去重，不会重复计数）。 */
const IMPORT_VERSION = '2';
const IMPORT_META_KEY = 'import_version';
/** 逐文件 lease 的等待上限：短暂并发发送等一下就过，长期迁移直接跳过（不读半迁移文件）。 */
const IMPORT_LEASE_WAIT_MS = 2_000;
/** 同时在读 / 解析的会话文件数。 */
const SCAN_CONCURRENCY = 4;

export interface ImportResult {
  files: number;
  added: number;
}

/** 一次会话迁移后的定位更新：只改归属项目，不改来源、账本键或历史调用。 */
export interface SessionLocationUpdate {
  sessionId: string;
  /** 托管 JSONL 路径；迁移不搬文件，这里必须与已登记路径一致。 */
  sessionPath: string;
  /** 迁移后的会话 cwd（目标项目）。 */
  cwd: string;
}

/** 迁移 journal 的恢复闸门：报表 / 补录前先等未完成事务恢复，避免从半更新 header 扫出错误定位。 */
export type UsageRecoveryGate = (paths: string[]) => Promise<void>;

export class UsageService {
  private readonly ledger: UsageLedger;
  private registry:UsageOriginRegistry | undefined;
  private importing: Promise<ImportResult> | null = null;
  private recoveryGate?: UsageRecoveryGate;
  private readonly leaseWaitMs: number;

  constructor(private readonly agentDir: string, options: { ledger?: UsageLedger; leaseWaitMs?: number } = {}) {
    this.ledger = options.ledger ?? sharedLedger(defaultLedgerPath(agentDir));
    this.leaseWaitMs = options.leaseWaitMs ?? IMPORT_LEASE_WAIT_MS;
  }

  /** 未完成迁移期间不要从半更新 header 汇总项目分组。传 undefined 取消（测试 / 单进程场景）。 */
  setRecoveryGate(gate: UsageRecoveryGate | undefined): void {
    this.recoveryGate = gate;
  }

  async report(filters?: UsageFilters): Promise<UsageReport> {
    return this.ledger.report(filters, {worksDir: await this.reportDirectories()});
  }

  async calls(query: CallQuery) {
    return this.ledger.calls(query, {worksDir: await this.reportDirectories()});
  }

  private async reportDirectories() {
    // 报表读的是账本里已登记的会话定位；迁移还没恢复完时先等，避免读出中间态。
    await this.recoveryGate?.([]);
    if (this.ledger.getMeta(IMPORT_META_KEY) !== IMPORT_VERSION) await this.reconcile({ skipRecoveryGate: true });
    // WorkspaceService creates scratch conversations under realpath(works), including Windows junctions.
    const worksDir = join(this.agentDir, 'works');
    const resolved = await realpath(worksDir).catch(() => worksDir);
    return [worksDir, resolved];
  }

  /**
   * 迁移后更新会话定位元数据（cwd，必要时 path）。可信入口：只由宿主迁移 owner 调用。
   *
   * 约束（design 8）：保留 session id、托管路径、origin 绑定和 canonical ledger key；
   * 不调用 clone / import 的来源登记，不写新调用，也不重算历史。项目身份仍以 sessions.cwd 为准，
   * 所以移动后整段历史跟着目标项目，而 tokens / cost / messages 不变。
   *
   * 本方法不等待恢复闸门：它就是恢复流程的一部分（committed 恢复会先补定位再 retry-open）。
   */
  async updateSessionLocation(updates: SessionLocationUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;
    const registry = new UsageOriginRegistry(defaultOriginRegistryPath(this.agentDir));
    try {
      let changed = 0;
      this.ledger.transaction(() => {
        for (const update of updates) {
          if (!update.sessionId.trim() || !update.cwd.trim()) throw new Error('USAGE_SESSION_LOCATION_INVALID');
          // 来源登记若已存在，必须仍是同一物理路径：迁移只改 header cwd，不搬 JSONL。
          const owned = registry.sessionPath(update.sessionId);
          if (owned !== undefined && owned !== resolve(update.sessionPath)) throw new Error('USAGE_SESSION_PATH_MISMATCH');
          // 只更新已登记的行；没用过量的会话留给之后的 reconcile 正常补录，不在这里造空行。
          if (this.ledger.setSessionLocation({ id: update.sessionId, path: update.sessionPath, cwd: update.cwd })) changed += 1;
        }
      });
      return changed;
    } finally {
      registry.close();
    }
  }

  /** 扫一遍会话目录，把账本里没有的调用补进去。同时来的几次共用一次扫描。 */
  reconcile(options: { skipRecoveryGate?: boolean } = {}): Promise<ImportResult> {
    // 并发调用必须拿到同一个 promise：闸门放进共享任务里，不改变「同时来就只有一次扫描」。
    this.importing ??= this.runImport(options).finally(() => { this.importing = null; });
    return this.importing;
  }

  private async runImport(options: { skipRecoveryGate?: boolean }): Promise<ImportResult> {
    // 未完成迁移的会话先恢复：半更新 header 会被补录成错误定位，且可能重复计入。
    if (!options.skipRecoveryGate) await this.recoveryGate?.([]);
    return this.importSessions();
  }

  private async importSessions(): Promise<ImportResult> {
    this.registry=new UsageOriginRegistry(defaultOriginRegistryPath(this.agentDir));
    try {
    ensureLegacyRoster(this.agentDir,this.registry);
    const paths = await collectJsonl(join(this.agentDir, 'sessions'));
    let added = 0;
    // 有文件因为未完成迁移 / 正在被写而没读时，不把导入标记为完成：下次报表会重试，
    // 而不是拿半更新 header 的旧定位当最终口径。
    let complete = true;
    let cursor = 0;
    const worker = async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++];
        const outcome = await this.importPath(path);
        added += outcome.added;
        if (!outcome.complete) complete = false;
        // 解析是同步的，每个文件之间回到事件循环，别让 agent-host 的会话事件排队太久。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    if (complete) this.ledger.setMeta(IMPORT_META_KEY, IMPORT_VERSION);
    return { files: paths.length, added };
    } finally {this.registry.close();this.registry=undefined;}
  }

  /**
   * 一个文件：先按路径等恢复闸门，再持与迁移 / 运行时共享的 lease 读取并补录。
   *
   * 只在 scan 前等一次全局闸门不够：扫描跑几十秒，迁移可能在中途进入 applying / committed，
   * 这里读到的会是半更新 header 的旧定位，upsertSession 会把刚提交的目标 cwd 覆盖回源项目。
   * 闸门按路径问（不是 []），避免和迁移恢复自身重入全局闸门而死锁。
   * 未完成迁移（blocked）或长期被别的写者占用（busy）时不读该文件，也不宣称导入完成。
   */
  private async importPath(path: string): Promise<{ added: number; complete: boolean }> {
    if (this.recoveryGate) {
      try {
        await this.recoveryGate([path]);
      } catch {
        return { added: 0, complete: false };
      }
    }
    let added = 0;
    try {
      await withSessionOperationLease(this.agentDir, [path], async () => {
        let buffer: Buffer;
        // 文件被删 / 正在原子替换：本轮跳过，不是导入失败。
        try { buffer = await readFile(path); } catch { return; }
        added += this.importFile(path, buffer);
      }, { waitMs: this.leaseWaitMs });
      return { added, complete: true };
    } catch (error) {
      if (error instanceof SessionOperationLeaseBlockedError || error instanceof SessionOperationLeaseBusyError) {
        return { added, complete: false };
      }
      throw error;
    }
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
    const required=buffer.includes(Buffer.from('"usage_origin_required"'));
    const registry=this.registry!;
    const legacy=registry.isLegacySession({sessionId,path,required});
    const warms:NonNullable<ReturnType<typeof warmFromEntry>>[]=[];
    const calls: NonNullable<ReturnType<typeof callFromMessage>>[] = [];
    forEachLineContaining(buffer, '"usage"', (line) => {

      const entry = parse(line);
      if(!entry)return;
      const entryId=text(entry.id);if(!entryId)return;
      let origin=registry.resolveUsageOrigin({sessionId,entryId});
      if(origin.kind==='unverified'&&legacy){registry.registerLocalEntry({sessionId,entryId},path);origin=registry.resolveUsageOrigin({sessionId,entryId});}
      if(origin.kind!=='local-origin')return;
      const original=origin.originSessionId===sessionId&&origin.originEntryId===entryId;
      const canonical=registry.ledgerKey({sessionId,entryId});
      // A copy may only reference an existing canonical binding; its fields cannot backfill.
      if(!original||!registry.ownsSessionPath(sessionId,path))return;
      const warm=warmFromEntry(entry,sessionId);if(warm){warms.push(warm);return;}
      if (entry.type !== 'message') return;
      const call = callFromMessage(entry.message, sessionId, text(entry.timestamp) ?? headerTimestamp);
      if (call) { if(legacy && typeof (entry.message as any)?.usage?.cost?.totalFromProvider!=='boolean' && typeof (entry.message as any)?.responseModel!=='string')call.costSource='unknown';calls.push({ ...call, entryId, ...(canonical?{canonicalKey:canonical}:{}) });}
    });
    // An untrusted copy must not move legitimate spend by replacing the original cwd or title.
    const owner = registry.sessionPath(sessionId);
    if (owner !== undefined && owner !== resolve(path)) return 0;
    return this.ledger.transaction(() => {
      this.ledger.upsertSession({ id: sessionId, path, cwd: text(header.cwd), startedAt: headerTimestamp, name }, { onlySamePath: !owner });
      let added = 0;
      for (const call of calls) { if (this.ledger.record(call, 'import')) added += 1; const key=callKey(call);if(key&&call.entryId)registry.bindLedgerKey({sessionId,entryId:call.entryId},key); }
      for(const warm of warms){if(this.ledger.recordWarm(warm))added+=1;registry.bindLedgerKey({sessionId,entryId:warm.entryId},warmKey(warm));}
      return added;
    });
  }
}

async function collectJsonl(directory: string): Promise<string[]> { try { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map((entry) => entry.isDirectory() ? collectJsonl(join(directory, entry.name)) : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : []))).flat(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
function parse(line: string): Record<string, unknown> | null { try { const value = JSON.parse(line) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
