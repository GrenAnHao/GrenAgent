import { describe, it, expect } from 'vitest';
import { buildProjectGroups, mergeProjectRegistrations, sharePreviousGroups } from './useProjectGroups';
import type { SessionInfo } from '../../lib/pi';

const s = (cwd: string, ts: string): SessionInfo => ({
  id: cwd + ts,
  path: `${cwd}/${ts}.jsonl`,
  cwd,
  timestamp: ts,
  name: null,
});

describe('buildProjectGroups worksDir filter', () => {
  it('excludes sessions under worksDir', () => {
    const sessions = [s('/home/.pi/agent/works/u1', 't1'), s('/proj/a', 't2')];
    const groups = buildProjectGroups(sessions, {
      current: '',
      pinnedProjects: [],
      hiddenProjects: [],
      aliases: {},
      keyword: '',
      worksDir: '/home/.pi/agent/works',
      registeredProjects: [],
    });
    expect(groups.map((g) => g.cwd)).toEqual(['/proj/a']);
  });

  it('includes registered projects with no sessions yet', () => {
    const groups = buildProjectGroups([], {
      current: '/proj/new',
      pinnedProjects: [],
      hiddenProjects: [],
      aliases: {},
      keyword: '',
      worksDir: '/home/.pi/agent/works',
      registeredProjects: ['/proj/new'],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].cwd).toBe('/proj/new');
    expect(groups[0].sessions).toHaveLength(0);
    expect(groups[0].isCurrent).toBe(true);
  });

  it('merges persisted empty projects without duplicating runtime ones', () => {
    expect(mergeProjectRegistrations(['/proj/a'], ['/proj/a', '/proj/empty'])).toEqual([
      '/proj/a',
      '/proj/empty',
    ]);
  });

  it('does not bump the current project to the top (stable order on open)', () => {
    const sessions = [
      s('/proj/a', '2026-01-02T00:00:00Z'), // 最近活跃
      s('/proj/b', '2026-01-01T00:00:00Z'), // 较旧
    ];
    const groups = buildProjectGroups(sessions, {
      current: '/proj/b', // 打开较旧的项目
      pinnedProjects: [],
      hiddenProjects: [],
      aliases: {},
      keyword: '',
      worksDir: '/home/.pi/agent/works',
      registeredProjects: [],
    });
    // 仍按最近活跃排序：a 在前、b 在后；当前项目 b 不被置顶，避免打开即重排。
    expect(groups.map((g) => g.cwd)).toEqual(['/proj/a', '/proj/b']);
    expect(groups[1].isCurrent).toBe(true);
  });
});

describe('sharePreviousGroups', () => {
  const params = (current: string) => ({ current, pinnedProjects: [], hiddenProjects: [], aliases: {}, keyword: '', worksDir: '', registeredProjects: [] });

  it('切到另一个项目只换掉 isCurrent 变了的两组，其余分组和所有会话对象沿用', () => {
    const sessions = [s('D:/a', '2026-10-01'), s('D:/b', '2026-10-02'), s('D:/c', '2026-10-03')];
    const before = buildProjectGroups(sessions, params('D:/a'));
    const after = sharePreviousGroups(before, buildProjectGroups(sessions.map((x) => ({ ...x })), params('D:/b')));

    const byCwd = (groups: typeof before, cwd: string) => groups.find((g) => g.cwd === cwd)!;
    expect(byCwd(after, 'D:/c')).toBe(byCwd(before, 'D:/c'));
    expect(byCwd(after, 'D:/a')).not.toBe(byCwd(before, 'D:/a'));
    expect(byCwd(after, 'D:/a').sessions[0]).toBe(byCwd(before, 'D:/a').sessions[0]);
    expect(byCwd(after, 'D:/b').isCurrent).toBe(true);
  });
});
