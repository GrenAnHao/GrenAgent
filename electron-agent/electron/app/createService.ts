import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ImageItem { name: string; bytes: number; modifiedMs: number; }

export class CreateService {
  async list(workspace: string): Promise<ImageItem[]> {
    const directory = join(workspace, '.pi', 'images');
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const images = await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) return null;
        const metadata = await stat(join(directory, entry.name));
        return { name: entry.name, bytes: metadata.size, modifiedMs: metadata.mtimeMs };
      }));
      return images.filter((item): item is ImageItem => item !== null).sort((left, right) => right.modifiedMs - left.modifiedMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async read(workspace: string, name: string): Promise<string> {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error('invalid image name');
    return (await readFile(join(workspace, '.pi', 'images', name))).toString('base64');
  }
}
