import { describe, it, expect } from 'vitest';
import { buildProjectGroups } from './useProjectGroups';
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
