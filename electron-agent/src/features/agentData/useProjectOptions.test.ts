// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectOptions } from './useProjectOptions';
import { useSessionStore } from '../../store';

beforeEach(() => {
  useSessionStore.setState({
    allSessions: [
      // 插入顺序刻意乱序：zeta 字典序排在 beta 之后，排序断言才可失效
      { id: '1', path: '/s/1.jsonl', cwd: 'D:/proj/zeta', timestamp: '2026-09-01T00:00:00Z', name: null },
      { id: '2', path: '/s/2.jsonl', cwd: 'D:/home/.pi/agent/works/abc', timestamp: '2026-09-02T00:00:00Z', name: null },
    ],
    optimisticSessions: [],
    deletedSessionPaths: [],
    registeredProjects: ['D:/proj/beta'],
    worksDir: 'D:/home/.pi/agent/works',
    // 与上方 zeta 指向同一项目的大小写/分隔符/尾斜杠变体：朴素字符串去重无法合并它
    activeWorkspace: 'd:\\proj\\zeta\\',
  });
});

describe('useProjectOptions', () => {
  it('lists project cwds with display names and excludes scratch conversations', () => {
    const { result } = renderHook(() => useProjectOptions());
    // 排序后 beta 先于 zeta；zeta 的两个字符串变体经 pathsEquivalent 去重，仅保留首次出现的写法
    expect(result.current).toEqual([
      { cwd: 'D:/proj/beta', name: 'beta' },
      { cwd: 'D:/proj/zeta', name: 'zeta' },
    ]);
  });

  it('includes the active workspace even when it has no session yet', () => {
    useSessionStore.setState({ activeWorkspace: 'D:/proj/gamma' });
    const { result } = renderHook(() => useProjectOptions());
    expect(result.current.map((option) => option.cwd)).toContain('D:/proj/gamma');
  });

  it('distinguishes equal project names using their parent paths', () => {
    useSessionStore.setState({ allSessions: [], activeWorkspace: '', registeredProjects: ['D:/one/app', 'D:/two/app'] });
    const { result } = renderHook(() => useProjectOptions());
    expect(result.current).toEqual([
      { cwd: 'D:/one/app', name: 'app · D:/one' },
      { cwd: 'D:/two/app', name: 'app · D:/two' },
    ]);
  });
});
