import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class WorkspaceApprovalService {
  private readonly approvalsPath: string;

  constructor(private readonly dataDir: string) {
    this.approvalsPath = join(dataDir, 'workspace-approvals.json');
  }

  async approve(path: string): Promise<void> {
    const canonical = await realpath(path);
    const approvals = await this.read();
    approvals.add(normalizePath(canonical));
    await this.write(approvals);
  }

  async isApproved(path: string): Promise<boolean> {
    const canonical = await realpath(path);
    return (await this.read()).has(normalizePath(canonical));
  }

  private async read(): Promise<Set<string>> {
    try {
      const value = JSON.parse(await readFile(this.approvalsPath, 'utf8')) as unknown;
      if (!Array.isArray(value) || !value.every((path) => typeof path === 'string')) return new Set();
      return new Set(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
  }

  private async write(approvals: Set<string>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.approvalsPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...approvals], null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.approvalsPath);
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
