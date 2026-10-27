import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILE_TABS,
  closeFileTabs,
  fileTabLabels,
  openFileTab,
  sanitizeFileTabs,
  tabsInScope,
  type FileTabsState,
} from './fileTabsModel';

const three: FileTabsState = { paths: ['/r/a.ts', '/r/b.ts', '/r/c.ts'], active: '/r/b.ts' };

describe('fileTabsModel', () => {
  it('opens new files at the end and reuses an open tab, including another spelling of the same path', () => {
    let s = openFileTab(EMPTY_FILE_TABS, 'E:/r/a.ts');
    s = openFileTab(s, 'E:/r/b.ts');
    expect(s).toEqual({ paths: ['E:/r/a.ts', 'E:/r/b.ts'], active: 'E:/r/b.ts' });
    const again = openFileTab(s, 'E:\\r\\a.ts');
    expect(again).toEqual({ paths: ['E:/r/a.ts', 'E:/r/b.ts'], active: 'E:/r/a.ts' });
    expect(openFileTab(again, 'E:/r/a.ts')).toBe(again);
  });

  it('activates the right neighbour when the active tab closes, else the left one', () => {
    expect(closeFileTabs(three, ['/r/b.ts'])).toEqual({ paths: ['/r/a.ts', '/r/c.ts'], active: '/r/c.ts' });
    expect(closeFileTabs({ ...three, active: '/r/c.ts' }, ['/r/c.ts'])).toEqual({ paths: ['/r/a.ts', '/r/b.ts'], active: '/r/b.ts' });
    expect(closeFileTabs(three, ['/r/b.ts', '/r/c.ts'])).toEqual({ paths: ['/r/a.ts'], active: '/r/a.ts' });
    expect(closeFileTabs(three, tabsInScope(three, '/r/a.ts', 'all'))).toEqual({ paths: [], active: null });
  });

  it('keeps the active tab when another one closes, and returns to preferActive after a temporary switch', () => {
    expect(closeFileTabs(three, ['/r/a.ts'])).toEqual({ paths: ['/r/b.ts', '/r/c.ts'], active: '/r/b.ts' });
    expect(closeFileTabs({ ...three, active: '/r/c.ts' }, ['/r/c.ts'], '/r/a.ts')).toEqual({ paths: ['/r/a.ts', '/r/b.ts'], active: '/r/a.ts' });
    expect(closeFileTabs(three, ['/r/zzz.ts'])).toBe(three);
  });

  it('lists the tabs each context menu entry closes', () => {
    expect(tabsInScope(three, '/r/b.ts', 'self')).toEqual(['/r/b.ts']);
    expect(tabsInScope(three, '/r/b.ts', 'others')).toEqual(['/r/a.ts', '/r/c.ts']);
    expect(tabsInScope(three, '/r/b.ts', 'right')).toEqual(['/r/c.ts']);
    expect(tabsInScope(three, '/r/c.ts', 'right')).toEqual([]);
  });

  it('sanitizes persisted tabs', () => {
    expect(sanitizeFileTabs(['/r/a.ts', '/r/a.ts', '', 3, '/r/b.ts'], '/r/b.ts')).toEqual({ paths: ['/r/a.ts', '/r/b.ts'], active: '/r/b.ts' });
    expect(sanitizeFileTabs(['/r/a.ts'], '/r/gone.ts')).toEqual({ paths: ['/r/a.ts'], active: '/r/a.ts' });
    expect(sanitizeFileTabs(undefined, null)).toEqual(EMPTY_FILE_TABS);
  });

  it('labels tabs by file name and adds the shortest distinguishing folder for duplicates', () => {
    expect(fileTabLabels(['/r/README.md', '/r/src/app.ts'])).toEqual([
      { name: 'README.md', hint: '' },
      { name: 'app.ts', hint: '' },
    ]);
    expect(fileTabLabels(['/r/docs/guide.md', '/r/src/guide.md', '/r/a/src/guide.md']).map((l) => l.hint)).toEqual(['docs', 'r/src', 'a/src']);
    expect(fileTabLabels(['C:\\r\\x\\index.ts', 'C:\\r\\y\\index.ts']).map((l) => l.hint)).toEqual(['x', 'y']);
  });
});
