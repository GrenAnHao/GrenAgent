// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectOptions } from './useProjectOptions';
import { useSessionStore } from '../../store';

beforeEach(() => {
  useSessionStore.setState({
    allSessions: [
      { id: '1', path: '/s/1.jsonl', cwd: 'D:/proj/alpha', timestamp: '2026-09-01T00:00:00Z', name: null },
      { id: '2', path: '/s/2.jsonl', cwd: 'D:/home/.pi/agent/works/abc', timestamp: '2026-09-02T00:00:00Z', name: null },
    ],
    optimisticSessions: [],
    deletedSessionPaths: [],
    registeredProjects: ['D:/proj/beta'],
    worksDir: 'D:/home/.pi/agent/works',
    activeWorkspace: 'D:/proj/alpha',
  });
});

describe('useProjectOptions', () => {
  it('lists project cwds with display names and excludes scratch conversations', () => {
    const { result } = renderHook(() => useProjectOptions());
    expect(result.current).toEqual([
      { cwd: 'D:/proj/alpha', name: 'alpha' },
      { cwd: 'D:/proj/beta', name: 'beta' },
    ]);
  });

  it('includes the active workspace even when it has no session yet', () => {
    useSessionStore.setState({ activeWorkspace: 'D:/proj/gamma' });
    const { result } = renderHook(() => useProjectOptions());
    expect(result.current.map((option) => option.cwd)).toContain('D:/proj/gamma');
  });
});
