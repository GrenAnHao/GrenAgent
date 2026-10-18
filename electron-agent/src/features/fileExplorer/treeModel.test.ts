import { describe, expect, it } from 'vitest';
import type { DirEntry } from '../../lib/files';
import { ancestorDirs, buildTree, dirsToWatch, isDescendant, searchTree, toTreePath, withListing, type DirMap } from './treeModel';

const dir = (path: string): DirEntry => ({ name: path.split('/').pop()!, path, isDir: true, size: null });
const file = (path: string, size = 1): DirEntry => ({ name: path.split('/').pop()!, path, isDir: false, size });

const loaded: DirMap = new Map([
  ['/r', [dir('/r/src'), dir('/r/docs'), file('/r/README.md')]],
  ['/r/src', [dir('/r/src/ui'), file('/r/src/main.ts')]],
  ['/r/src/ui', [file('/r/src/ui/Button.tsx')]],
]);

describe('treeModel', () => {
  it('rewrites a forward-slash workspace path into the tree form of the listed root', () => {
    expect(toTreePath('D:\\ws', 'D:/ws', 'D:/ws/src/a.ts')).toBe('D:\\ws\\src\\a.ts');
    expect(toTreePath('/r', '/r', '/r/src/a.ts')).toBe('/r/src/a.ts');
    expect(toTreePath('/r', '/r', '/other/a.ts')).toBe('/other/a.ts');
  });

  it('lists the ancestor directories of a file from shallow to deep, without the root', () => {
    expect(ancestorDirs('D:\\ws', 'D:\\ws\\src\\ui\\a.ts')).toEqual(['D:\\ws\\src', 'D:\\ws\\src\\ui']);
    expect(ancestorDirs('/r', '/r/a.ts')).toEqual([]);
    expect(ancestorDirs('/r', '/elsewhere/a.ts')).toEqual([]);
  });

  it('builds nested nodes only for loaded directories', () => {
    const tree = buildTree('/r', loaded);
    expect(tree.map((n) => [n.key, n.isLeaf, n.children?.length])).toEqual([
      ['/r/src', false, 2],
      ['/r/docs', false, undefined],
      ['/r/README.md', true, undefined],
    ]);
    expect(tree[0].children?.[0].children?.[0].key).toBe('/r/src/ui/Button.tsx');
  });

  it('replaces one listing and prunes removed subdirectories with everything loaded below them', () => {
    const next = withListing(loaded, '/r', [dir('/r/docs'), file('/r/README.md'), file('/r/new.txt')]);
    expect([...next.keys()].sort()).toEqual(['/r']);
    expect(next.get('/r')?.map((e) => e.name)).toEqual(['docs', 'README.md', 'new.txt']);
    expect(loaded.has('/r/src/ui')).toBe(true);
  });

  it('keeps loaded subdirectories that still exist', () => {
    const next = withListing(loaded, '/r/src', [dir('/r/src/ui'), file('/r/src/other.ts')]);
    expect(next.get('/r/src/ui')).toBe(loaded.get('/r/src/ui'));
  });

  it('searches loaded names case-insensitively and expands every ancestor of a match', () => {
    const hit = searchTree('/r', loaded, 'BUTTON');
    expect(hit?.matches).toBe(1);
    expect([...(hit?.expand ?? [])]).toEqual(['/r/src', '/r/src/ui']);
    expect(buildTree('/r', loaded, hit?.visible).map((n) => n.key)).toEqual(['/r/src']);
    expect(searchTree('/r', loaded, '   ')).toBeNull();
    expect(searchTree('/r', loaded, 'zzz')?.matches).toBe(0);
  });

  it('watches the root plus expanded directories that are loaded', () => {
    expect(dirsToWatch('/r', loaded, ['/r/src', '/r/docs', '/r'])).toEqual(['/r', '/r/src']);
  });

  it('treats both separators as path boundaries', () => {
    expect(isDescendant('C:\\r\\src\\a', 'C:\\r\\src')).toBe(true);
    expect(isDescendant('/r/srcx', '/r/src')).toBe(false);
    expect(isDescendant('/r/src', '/r/src')).toBe(false);
  });
});
