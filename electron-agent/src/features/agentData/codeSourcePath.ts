import { isUnder, pathsEquivalent } from '../../lib/pathUtils';

export function sourcePath(workspace: string, file: string): { absolute: string; relative: string } | undefined {
  const normalize = (value: string) =>
    value
      .replace(/\\/g, '/')
      .replace(/^\/\/\?\/UNC\//i, '//')
      .replace(/^\/\/\?\//, '');
  const root = normalize(workspace).replace(/\/+$/, '');
  const requested = normalize(file);
  const isAbsolute = (value: string) => /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/|\/)/i.test(value);
  if (!root || !isAbsolute(root) || !requested || /[\0-\x1f]/.test(requested)) return undefined;
  if (requested.split('/').includes('..') || root.split('/').includes('..')) return undefined;
  if (/^[a-z]:(?!\/)/i.test(requested) || /:/.test(requested.replace(/^[a-z]:/i, ''))) return undefined;
  const absolute = isAbsolute(requested) ? requested : `${root}/${requested.replace(/^(?:\.\/)+/, '')}`;
  if (!isUnder(absolute, root) || pathsEquivalent(absolute, root)) return undefined;
  return { absolute, relative: absolute.slice(root.length + 1) };
}
