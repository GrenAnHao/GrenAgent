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

describe('buildProjectGroups isolated workspaces', () => {
  const params = {
    current: '', pinnedProjects: [] as string[], hiddenProjects: [] as string[], aliases: {} as Record<string, string>,
    keyword: '', worksDir: '', registeredProjects: [] as string[],
  };

  it('glues each isolated workspace right under its parent, named by branch, without moving the parent', () => {
    const sessions = [
      s('D:/repo/.gren/worktrees/aaa11111', '2026-10-05'),
      s('D:/other', '2026-10-04'),
      s('D:/repo', '2026-10-01'),
      s('D:/repo/.gren/worktrees/bbb22222', '2026-10-03'),
    ];
    const groups = buildProjectGroups(sessions, params);
    expect(groups.map((g) => g.name)).toEqual(['other', 'repo', 'gren/aaa11111', 'gren/bbb22222']);
    expect(groups[2]?.isolated).toEqual({ parentCwd: 'D:/repo', id: 'aaa11111', branch: 'gren/aaa11111', parentListed: true });
    expect(groups[1]?.isolated).toBeUndefined();
  });

  it('without the parent in the list, keeps its own place and prefixes the parent name', () => {
    const groups = buildProjectGroups([s('D:/repo/.gren/worktrees/aaa11111', '2026-10-05')], params);
    expect(groups[0]).toMatchObject({ name: 'repo · gren/aaa11111', isolated: { parentListed: false, parentCwd: 'D:/repo' } });
  });

  it('an alias wins over the branch name', () => {
    const groups = buildProjectGroups([s('D:/repo', '1'), s('D:/repo/.gren/worktrees/aaa11111', '2')], {
      ...params,
      aliases: { 'D:/repo/.gren/worktrees/aaa11111': '修登录' },
    });
    expect(groups.map((g) => g.name)).toEqual(['repo', '修登录']);
  });
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
