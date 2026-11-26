import { useCallback, useMemo, useState } from 'react';
import { pathKey } from '../../lib/pathUtils';
import { useProjectOptions } from './useProjectOptions';

const HIDDEN = 'pi-code-index-hidden-projects';
const RECENT = 'pi-code-index-recent';

function readPaths(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export const recentIndexPaths = () => readPaths(RECENT);

export function rememberIndexProject(path: string) {
  const key = pathKey(path);
  try {
    localStorage.setItem(RECENT, JSON.stringify([key, ...recentIndexPaths().filter((p) => p !== key)].slice(0, 24)));
  } catch {
    // The recent order is a convenience; a storage failure must not block browsing.
  }
}

export function useIndexProjectCatalog() {
  const projects = useProjectOptions();
  const [hidden, setHidden] = useState(() => readPaths(HIDDEN));
  const setListed = useCallback(
    (path: string, listed: boolean) => {
      const key = pathKey(path);
      if (hidden.includes(key) === !listed) return;
      const next = listed ? hidden.filter((p) => p !== key) : [...hidden, key];
      localStorage.setItem(HIDDEN, JSON.stringify(next));
      setHidden(next);
    },
    [hidden],
  );
  const options = useMemo(() => projects.filter((p) => !hidden.includes(pathKey(p.cwd))), [projects, hidden]);
  return { projects, options, setListed };
}
