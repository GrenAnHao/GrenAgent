import type { DatabaseSync } from 'node:sqlite';
import type { PluginStateRecord } from './pluginManager';

/**
 * plugin_state 表的读写。PluginManager 只在构造时读一次全部记录，之后每次状态迁移写一行。
 * 生产路径由主进程内的运行时持有并提供数据库连接。
 */
export class PluginStateStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 按更新时间顺序的全部记录；损坏的行跳过（与原来 restore 的行为一致）。 */
  load(): PluginStateRecord[] {
    const rows = this.db.prepare('SELECT payload FROM plugin_state ORDER BY updated_at ASC').all() as Array<{ payload: string }>;
    const records: PluginStateRecord[] = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row.payload) as PluginStateRecord;
        if (record && typeof record.id === 'string' && typeof record.state === 'string') records.push(record);
      } catch {
        // A corrupt plugin record is isolated from all other plugin state.
      }
    }
    return records;
  }

  save(record: PluginStateRecord): void {
    if (!record || typeof record.id !== 'string' || typeof record.state !== 'string' || !Number.isFinite(record.updatedAt)) throw new Error('invalid plugin state record');
    this.db.prepare(`INSERT INTO plugin_state(id, state, payload, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(record.id, record.state, JSON.stringify(record), record.updatedAt);
  }
}
