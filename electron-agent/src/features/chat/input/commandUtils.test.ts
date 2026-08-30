import { describe, it, expect } from 'vitest';
import {
  commandMatchesQuery,
  getFrontendCommands,
  mergeCommands,
  parseCommands,
  parseSlashMenuValue,
  slashMenuValue,
  toSlashMenuItems,
} from './commandUtils';
import type { PiCommand } from './commandTypes';

describe('parseCommands', () => {
  it('parses a raw array from Pi extension API', () => {
    const raw = [
      {
        name: 'review',
        description: 'Run project review',
        source: 'extension',
      },
    ];
    expect(parseCommands(raw)).toEqual([
      {
        name: 'review',
        description: 'Run project review',
        source: 'api',
        apiSource: 'extension',
      },
    ]);
  });

  it('unwraps a { commands } envelope', () => {
    expect(
      parseCommands({
        commands: [{ name: 'model', description: 'Select model', apiSource: 'builtin' }],
      }),
    ).toEqual([
      {
        name: 'model',
        description: 'Select model',
        source: 'api',
        apiSource: 'builtin',
      },
    ]);
  });

  it('returns [] for unexpected shapes', () => {
    expect(parseCommands(null)).toEqual([]);
    expect(parseCommands({ other: 1 })).toEqual([]);
  });
});

describe('mergeCommands', () => {
  const frontend = getFrontendCommands();

  it('keeps frontend handlers for overlapping builtin names', () => {
    const api: PiCommand[] = [
      { name: 'compact', description: 'Native compact', source: 'api', apiSource: 'builtin' },
      { name: 'new', description: 'Native new', source: 'api', apiSource: 'builtin' },
      { name: 'model', description: 'Select model', source: 'api', apiSource: 'builtin' },
    ];

    expect(mergeCommands(api, frontend)).toEqual([
      { name: 'compact', description: '压缩上下文', source: 'frontend' },
      { name: 'model', description: 'Select model', source: 'api', apiSource: 'builtin' },
      { name: 'newSession', description: '新会话', source: 'frontend' },
    ]);
  });

  it('does not duplicate frontend items when API already has the same name', () => {
    const api: PiCommand[] = [{ name: 'review', description: 'Run review', source: 'api', apiSource: 'extension' }];
    const merged = mergeCommands(api, frontend);
    expect(merged.filter((c) => c.name === 'compact')).toHaveLength(1);
    expect(merged.some((c) => c.name === 'review')).toBe(true);
  });
});

describe('toSlashMenuItems', () => {
  it('groups commands by source', () => {
    const items = toSlashMenuItems([
      { name: 'compact', source: 'frontend' },
      { name: 'review', source: 'api', apiSource: 'extension' },
      { name: 'model', source: 'api', apiSource: 'builtin' },
    ]);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ label: '快捷操作' });
    expect(items[1]).toMatchObject({ label: '扩展' });
    expect(items[2]).toMatchObject({ label: '内置' });
  });

  it('shows skill commands without the skill: prefix but keeps the value prefixed', () => {
    const items = toSlashMenuItems([
      { name: 'skill:caveman', description: 'Caveman mode', source: 'api', apiSource: 'skill' },
    ]);

    expect(items).toHaveLength(1);
    const group = items[0] as {
      label: string;
      items: Array<{ label: string; value: string; keywords?: string[] }>;
    };
    expect(group.label).toBe('技能');
    expect(group.items[0].label).toBe('caveman');
    expect(group.items[0].value).toBe('api:skill:caveman');
    expect(group.items[0].keywords).toContain('caveman');
    expect(group.items[0].keywords).toContain('skill:caveman');
  });
});

describe('commandMatchesQuery', () => {
  const cmd = (name: string, description?: string): PiCommand => ({
    name,
    description,
    source: 'api',
    apiSource: 'extension',
  });

  it('matches by command-name prefix', () => {
    expect(commandMatchesQuery(cmd('compact'), 'com')).toBe(true);
    expect(commandMatchesQuery(cmd('compact'), 'COM')).toBe(true);
  });

  it('does NOT match when the query is only a non-prefix substring of the name', () => {
    // 旧实现用 includes 会把 'pact' 命中 'compact'——这正是用户反馈的「非前缀也搜出来」。
    expect(commandMatchesQuery(cmd('compact'), 'pact')).toBe(false);
  });

  it('does NOT match against the description', () => {
    // 名字不以 q 开头、只有描述里含 q，不应命中。
    expect(commandMatchesQuery(cmd('review', '压缩上下文'), '压缩')).toBe(false);
  });

  it('matches a skill by its display name (skill: prefix stripped)', () => {
    const skill: PiCommand = { name: 'skill:caveman', source: 'api', apiSource: 'skill' };
    expect(commandMatchesQuery(skill, 'cave')).toBe(true);
    expect(commandMatchesQuery(skill, 'skill')).toBe(true); // 原始名前缀仍可匹配
  });

  it('empty query matches everything', () => {
    expect(commandMatchesQuery(cmd('anything'), '')).toBe(true);
    expect(commandMatchesQuery(cmd('anything'), '   ')).toBe(true);
  });
});

describe('slashMenuValue', () => {
  it('roundtrips frontend and api values', () => {
    expect(parseSlashMenuValue(slashMenuValue({ name: 'compact', source: 'frontend' }))).toEqual({
      kind: 'frontend',
      name: 'compact',
    });
    expect(
      parseSlashMenuValue(slashMenuValue({ name: 'review', source: 'api', apiSource: 'extension' })),
    ).toEqual({ kind: 'api', name: 'review' });
  });
});
