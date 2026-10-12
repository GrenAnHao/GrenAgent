import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CODEGRAPH_INDEXED_HINT =
  'This workspace has a CodeGraph index. For codebase questions, start with code_explore. Do not start with bash, grep, or find.';

export const CODEGRAPH_FALLBACK_HINT =
  'This workspace has no CodeGraph index. For codebase questions, use grep, find, and read. Do not call code_explore until an index exists.';

export function hasCodeGraphIndex(workspace: string): boolean {
  return Boolean(workspace.trim()) && existsSync(join(workspace, '.codegraph', 'codegraph.db'));
}

export function codeGraphIndexHint(workspace: string): string {
  return hasCodeGraphIndex(workspace) ? CODEGRAPH_INDEXED_HINT : CODEGRAPH_FALLBACK_HINT;
}
