import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateService } from './createService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'electron-agent-create-'));
  directories.push(root);
  await mkdir(join(root, '.pi', 'images'), { recursive: true });
  return root;
}

describe('CreateService', () => {
  it('lists only PNG images in descending modified order', async () => {
    const root = await workspace();
    const images = join(root, '.pi', 'images');
    await writeFile(join(images, 'old.png'), Buffer.from([1]));
    await writeFile(join(images, 'new.PNG'), Buffer.from([2, 3]));
    await writeFile(join(images, 'skip.txt'), 'skip');
    await utimes(join(images, 'old.png'), new Date(1_000), new Date(1_000));
    await utimes(join(images, 'new.PNG'), new Date(2_000), new Date(2_000));

    await expect(new CreateService().list(root)).resolves.toEqual([
      expect.objectContaining({ name: 'new.PNG', bytes: 2 }), expect.objectContaining({ name: 'old.png', bytes: 1 }),
    ]);
  });

  it('reads an image as base64 and rejects non-file names', async () => {
    const root = await workspace();
    await writeFile(join(root, '.pi', 'images', 'image.png'), Buffer.from([0, 1, 2]));
    const service = new CreateService();
    await expect(service.read(root, 'image.png')).resolves.toBe('AAEC');
    await expect(service.read(root, '../image.png')).rejects.toThrow('invalid image name');
  });
});
