import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class UiHistoryService {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly resolveWorkspace: (workspace: string) => Promise<string>) {}

  async read(workspace: string, sessionKey: string): Promise<string> {
    const path = await this.historyPath(workspace, sessionKey);
    return this.enqueue(path, async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    });
  }

  async write(workspace: string, sessionKey: string, content: string): Promise<void> {
    const path = await this.historyPath(workspace, sessionKey);
    await this.enqueue(path, () => this.writeAtomically(path, content));
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
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
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
