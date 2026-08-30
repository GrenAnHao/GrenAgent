import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileService } from './fileService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'electron-agent-files-'));
  directories.push(root);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const ok = true;');
  await writeFile(join(root, 'README.md'), '# Demo');
  await writeFile(join(root, 'node_modules', 'hidden', 'x.js'), 'hidden');
  return root;
}

describe('FileService', () => {
  it('builds a bounded tree with directories first and omits ignored directories', async () => {
    const root = await workspace();
    const tree = await new FileService().tree(root, false);

    expect(tree.kind).toBe('directory');
    expect(tree.children?.map((node) => node.name)).toEqual(['src', 'README.md']);
    expect(tree.children?.[0]).toMatchObject({ kind: 'directory', children: [{ name: 'index.ts', kind: 'file', size: 23 }] });
  });

  it('reads and atomically writes only paths inside the workspace', async () => {
    const root = await workspace();
    const service = new FileService();

    await expect(service.read(root, 'README.md')).resolves.toBe('# Demo');
    await service.write(root, 'src/new.txt', 'created');
    await expect(readFile(join(root, 'src', 'new.txt'), 'utf8')).resolves.toBe('created');
    await expect(service.read(root, '../outside.txt')).rejects.toThrow('Path escapes workspace');
  });

  it('allows only registered dropped files and imports an allowed file under .pi/dropped', async () => {
    const root = await workspace();
    const external = await mkdtemp(join(tmpdir(), 'electron-agent-drop-'));
    directories.push(external);
    const source = join(external, 'sample.png');
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const service = new FileService();

    await expect(service.readDropped(source)).rejects.toThrow('File not in dropped allowlist');
    await service.registerDropped([source]);
    await expect(service.readDropped(source)).resolves.toEqual({ mime_type: 'image/png', data: 'iVBORw==', size: 4 });
    const imported = await service.importDropped(root, source);
    expect(imported).toMatch(/^\.pi\/dropped\/[a-f0-9]+\/sample\.png$/);
    await expect(readFile(join(root, imported), 'base64')).resolves.toBe('iVBORw==');
  });
});
