import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class TempHtmlService {
  constructor(private readonly temporaryDirectory: string) {}

  async write(content: string): Promise<string> {
    const path = join(this.temporaryDirectory, `pi-preview-${randomUUID()}.html`);
    await writeFile(path, content, 'utf8');
    return path;
  }
}
