import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

  it('lists one level with directories first, dotfiles kept and heavy directories skipped', async () => {
    const root = await workspace();
    await mkdir(join(root, '.github'));
    await mkdir(join(root, 'dist'));
    await mkdir(join(root, 'out'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await writeFile(join(root, 'file10.txt'), '');
    await writeFile(join(root, 'file2.txt'), '');
    const service = new FileService();

    const listing = await service.listDir(root, '');
    expect(listing.truncated).toBe(false);
    expect(listing.dir).toBe(await realpath(root));
    expect(listing.entries.map((entry) => [entry.name, entry.isDir])).toEqual([
      ['.github', true], ['src', true], ['.gitignore', false], ['file2.txt', false], ['file10.txt', false], ['README.md', false],
    ]);
    expect(listing.entries.find((entry) => entry.name === 'README.md')).toMatchObject({ size: 6, path: join(await realpath(root), 'README.md') });

    const nested = await service.listDir(root, join(root, 'src'));
    expect(nested.entries).toEqual([{ name: 'index.ts', path: join(await realpath(root), 'src', 'index.ts'), isDir: false, size: 23 }]);
    await expect(service.listDir(root, '..')).rejects.toThrow('Path escapes workspace');
  });

  it('reads text for the viewer, marks binary files and truncates past 5MB', async () => {
    const BOM = String.fromCharCode(0xfeff);
    const root = await workspace();
    await writeFile(join(root, 'bom.txt'), `${BOM}hello\r\nworld`);
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x14]));
    await writeFile(join(root, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 10, 0x61));
    const service = new FileService();

    await expect(service.readForView(root, 'bom.txt')).resolves.toEqual({
      kind: 'text', content: `${BOM}hello\r\nworld`, size: 15, truncated: false,
    });
    await expect(service.readForView(root, 'blob.bin')).resolves.toEqual({ kind: 'binary', size: 6 });
    const big = await service.readForView(root, 'big.log');
    expect(big).toMatchObject({ kind: 'text', size: 5 * 1024 * 1024 + 10, truncated: true });
    expect(big.kind === 'text' ? big.content.length : 0).toBe(5 * 1024 * 1024);
    await expect(service.readForView(root, '../../etc/passwd')).rejects.toThrow('Path escapes workspace');
  });

  it('resolves only existing paths inside the workspace', async () => {
    const root = await workspace();
    const service = new FileService();
    await expect(service.resolveExisting(root, 'README.md')).resolves.toBe(join(await realpath(root), 'README.md'));
    await expect(service.resolveExisting(root, 'missing.md')).rejects.toThrow('File does not exist');
    await expect(service.resolveExisting(root, '../x')).rejects.toThrow('Path escapes workspace');
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
