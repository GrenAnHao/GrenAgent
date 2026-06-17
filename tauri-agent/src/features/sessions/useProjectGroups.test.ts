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
});
