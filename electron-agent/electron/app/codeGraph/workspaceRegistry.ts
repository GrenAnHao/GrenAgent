/**
 * 已经查询过的工作区登记。codegraph-host 不持有 agent-data.db，所以写在它旁边的 json 里，重启后用来补同步。
 * 只在新增工作区或 HEAD 变化时落盘；每次查询都写会把磁盘打满。
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export interface WorkspaceRecord {
  workspace: string;
  head?: string;
  touchedAt: number;
}

interface RegistryFile { version: 1; workspaces: WorkspaceRecord[] }

export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(
    private readonly file: string | undefined,
    private readonly keyOf: (workspace: string) => string,
    private readonly readFile: (file: string) => string | undefined,
    private readonly writeFile: (file: string, text: string) => void,
    private readonly limit = 32,
  ) {
    if (!file) return;
    const parsed = parseRegistry(readFile(file));
    for (const record of parsed) this.records.set(this.keyOf(record.workspace), record);
  }

  list(): WorkspaceRecord[] { return [...this.records.values()]; }

  head(key: string): string | undefined { return this.records.get(key)?.head; }

  /** 记下第一次看见的 HEAD，或者分支切换落定后的 HEAD。没变化不写盘。 */
  setHead(key: string, head: string): void {
    const record = this.records.get(key);
    if (!record || record.head === head) return;
    record.head = head;
    this.save();
  }

  /** @returns 这个工作区是不是这次才登记。 */
  touch(workspace: string, touchedAt: number): boolean {
    const key = this.keyOf(workspace);
    const existing = this.records.get(key);
    if (existing) {
      existing.touchedAt = touchedAt;
      existing.workspace = workspace;
      this.records.delete(key);
      this.records.set(key, existing);
      return false;
    }
    this.records.set(key, { workspace, touchedAt });
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.save();
    return true;
  }

  save(): void {
    if (!this.file) return;
    const body: RegistryFile = { version: 1, workspaces: [...this.records.values()] };
    try { this.writeFile(this.file, JSON.stringify(body)); } catch { /* 下次变更再写 */ }
  }
}

export function createWorkspaceRegistry(file: string | undefined, keyOf: (workspace: string) => string): WorkspaceRegistry {
  return new WorkspaceRegistry(file, keyOf, (path) => {
    try { return readFileSync(path, 'utf8'); } catch { return undefined; }
  }, (path, text) => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text);
    rmSync(path, { force: true });
    renameSync(temporary, path);
  }, 32);
}

export function parseRegistry(text: string | undefined): WorkspaceRecord[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { version?: unknown; workspaces?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { workspace?: unknown; head?: unknown; touchedAt?: unknown };
      if (typeof row.workspace !== 'string' || !row.workspace) return [];
      return [{
        workspace: row.workspace,
        ...(typeof row.head === 'string' && row.head ? { head: row.head } : {}),
        touchedAt: typeof row.touchedAt === 'number' && Number.isFinite(row.touchedAt) ? row.touchedAt : 0,
      }];
    });
  } catch { return []; }
}
