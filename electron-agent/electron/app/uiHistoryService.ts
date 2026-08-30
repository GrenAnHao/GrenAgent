import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class UiHistoryService {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly resolveWorkspace: (workspace: string) => Promise<string>) {}

  async read(workspace: string, sessionKey: string): Promise<string> {
    const path = await this.historyPath(workspace, sessionKey);
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async write(workspace: string, sessionKey: string, content: string): Promise<void> {
    const path = await this.historyPath(workspace, sessionKey);
    const previous = this.pendingWrites.get(path) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.writeAtomically(path, content));
    this.pendingWrites.set(path, write);
    try {
      await write;
    } finally {
      if (this.pendingWrites.get(path) === write) this.pendingWrites.delete(path);
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
    await rm(path, { force: true });
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
