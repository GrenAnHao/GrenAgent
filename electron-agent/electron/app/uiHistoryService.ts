import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function historyRevision(file: Awaited<ReturnType<typeof revisionStat>>): string {
  return `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
}

const revisionStat = (path: string) => stat(path, { bigint: true });

export class UiHistoryService {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly resolveWorkspace: (workspace: string) => Promise<string>) {}

  async read(workspace: string, sessionKey: string): Promise<string> {
    return (await this.readSnapshot(workspace, sessionKey)).content;
  }

  async readSnapshot(workspace: string, sessionKey: string, checkpoint = false): Promise<{ content: string; revision?: string }> {
    const path = await this.historyPath(workspace, sessionKey);
    return this.enqueue(path, async () => {
      try {
        const before = checkpoint ? historyRevision(await revisionStat(path)) : undefined;
        const content = await readFile(path, 'utf8');
        const after = checkpoint ? historyRevision(await revisionStat(path)) : undefined;
        return { content, ...(before && before === after ? { revision: before } : {}) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '' };
        throw error;
      }
    });
  }

  async write(workspace: string, sessionKey: string, content: string, checkpoint = false): Promise<string | undefined> {
    const path = await this.historyPath(workspace, sessionKey);
    return this.enqueue(path, async () => {
      await this.writeAtomically(path, content);
      if (checkpoint) return historyRevision(await revisionStat(path));
    });
  }

  /** 只在已确认的文件版本上修改 UTF-8 尾段；旧文件格式保持不变。 */
  async patch(workspace: string, sessionKey: string, revision: string, offset: number, content: string): Promise<string | null> {
    const path = await this.historyPath(workspace, sessionKey);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid history offset');
    return this.enqueue(path, async () => {
      const current = await revisionStat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!current || historyRevision(current) !== revision) return null;
      const size = Number(current.size);
      if (offset > size) return null;
      if (offset === 0 && size > 0) {
        await this.writeAtomically(path, content);
      } else if (offset === size) {
        // 单一写者追加不会碰旧行。失败时撤掉本次未完成的尾段。
        try {
          await appendFile(path, content, 'utf8');
        } catch (error) {
          await truncate(path, offset).catch(() => {});
          throw error;
        }
      } else {
        // 替换（例如收齐工具结果）可能涉及已有行，仍按旧契约原子提交。
        await this.replaceAtomically(path, async (temporary) => {
          await copyFile(path, temporary);
          await truncate(temporary, offset);
          if (content) await appendFile(temporary, content, 'utf8');
        });
      }
      return historyRevision(await revisionStat(path));
    });
  }

  /** 读取和删除也遵守同一路径的提交顺序，不能越过尚未完成的旧写入。 */
  private async enqueue<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pendingWrites.get(path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    // 队列屏障本身不拒绝；原操作的错误仍交给调用方，失败不能堵住后续恢复。
    const settled = operation.then(() => undefined, () => undefined);
    this.pendingWrites.set(path, settled);
    try {
      return await operation;
    } finally {
      if (this.pendingWrites.get(path) === settled) this.pendingWrites.delete(path);
    }
  }

  private async writeAtomically(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await this.replaceAtomically(path, (temporary) => writeFile(temporary, content, 'utf8'));
  }

  private async replaceAtomically(path: string, write: (temporary: string) => Promise<void>): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await write(temporary);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async delete(workspace: string, sessionKey: string): Promise<void> {
    const path = await this.historyPath(workspace, sessionKey);
    await this.enqueue(path, () => rm(path, { force: true }));
  }

  private async historyPath(workspace: string, sessionKey: string): Promise<string> {
    const key = sanitizeKey(sessionKey);
    const resolvedWorkspace = await this.resolveWorkspace(workspace);
    return join(resolvedWorkspace, '.pi', 'ui-history', `${key}.jsonl`);
  }
}

function sanitizeKey(sessionKey: string): string {
  const key = sessionKey.trim();
  if (!key) throw new Error('session_key is required');
  if (key.includes('/') || key.includes('\\') || key.includes('..')) throw new Error('invalid session_key');
  return key;
}
