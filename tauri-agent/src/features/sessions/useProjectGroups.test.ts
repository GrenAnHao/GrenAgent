import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../lib/pi';
import { buildProjectGroups } from './useProjectGroups';

const s = (id: string, cwd: string, ts: string, name?: string): SessionInfo => ({
  id,
  path: `/sess/${id}.jsonl`,
  cwd,
  timestamp: ts,
  name: name ?? null,
});

describe('buildProjectGroups', () => {
  it('groups by cwd and sorts sessions desc by timestamp', () => {
    const groups = buildProjectGroups(
      [s('a', '/ws/p1', '2026-06-10T01:00:00Z'), s('b', '/ws/p1', '2026-06-10T03:00:00Z')],
      { current: '/ws/p1', pinnedProjects: [], hiddenProjects: [], aliases: {}, keyword: '' },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('puts current project first, then projects by most-recent activity', () => {
    const groups = buildProjectGroups(
      [
        s('a', '/ws/old', '2026-06-01T00:00:00Z'),
        s('b', '/ws/p1', '2026-06-10T00:00:00Z'),
        s('c', '/ws/new', '2026-06-12T00:00:00Z'),
      ],
      { current: '/ws/p1', pinnedProjects: [], hiddenProjects: [], aliases: {}, keyword: '' },
    );
    expect(groups.map((g) => g.cwd)).toEqual(['/ws/p1', '/ws/new', '/ws/old']);
    expect(groups[0].isCurrent).toBe(true);
  });

  it('marks pinned and excludes hidden; keyword filters by name/project', () => {
    const base = [
      s('a', '/ws/p1', '2026-06-10T00:00:00Z', 'Login fix'),
      s('b', '/ws/p2', '2026-06-11T00:00:00Z', 'Theme'),
    ];
    const pinned = buildProjectGroups(base, {
      current: '/ws/p1',
      pinnedProjects: ['/ws/p2'],
      hiddenProjects: [],
      aliases: {},
      keyword: '',
    });
    expect(pinned.find((g) => g.cwd === '/ws/p2')!.pinned).toBe(true);

    const hidden = buildProjectGroups(base, {
      current: '/ws/p1',
      pinnedProjects: [],
      hiddenProjects: ['/ws/p2'],
      aliases: {},
      keyword: '',
    });
    expect(hidden.find((g) => g.cwd === '/ws/p2')).toBeUndefined();

    const filtered = buildProjectGroups(base, {
      current: '/ws/p1',
      pinnedProjects: [],
      hiddenProjects: [],
      aliases: {},
      keyword: 'theme',
    });
    expect(filtered.map((g) => g.cwd)).toEqual(['/ws/p2']);
  });

  it('derives display name from alias or cwd basename', () => {
    const groups = buildProjectGroups(
      [s('a', '/ws/my-proj', '2026-06-10T00:00:00Z')],
      {
        current: '/ws/my-proj',
        pinnedProjects: [],
        hiddenProjects: [],
        aliases: { '/ws/my-proj': 'Alias' },
        keyword: '',
      },
    );
    expect(groups[0].name).toBe('Alias');
  });
});
