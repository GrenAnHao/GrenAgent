import { fileNameFromPath, getDetails } from '../tools/toolUtils';
import { fileDiffModel, isFileMutation, mutationPath } from '../tools/fileDiffModel';
import type { TimelineSegment } from './groupMessages';

export interface ChangeFile { path: string; display: string; added: number; deleted: number }
export interface PresentedFile { path: string; display: string; description?: string }

export function turnSettled(segments: TimelineSegment[]): boolean {
  return segments.every((segment) => {
    if (segment.kind === 'tool') return segment.status !== 'running';
    if (segment.kind === 'text' || segment.kind === 'thinking') return !segment.streaming;
    return true;
  });
}

export function changesForTurn(segments: TimelineSegment[]): ChangeFile[] {
  const files: ChangeFile[] = [];
  const index = new Map<string, number>();
  for (const segment of segments) {
    if (segment.kind !== 'tool' || segment.status !== 'done' || !isFileMutation(segment.toolName)) continue;
    const path = mutationPath(segment.args);
    const diff = fileDiffModel(segment.toolName, segment.args, segment.result, segment.status);
    if (!path || !diff) continue;
    const existing = index.get(path);
    if (existing === undefined) {
      index.set(path, files.length);
      files.push({ path, display: fileNameFromPath(path), added: diff.added, deleted: diff.deleted });
    } else {
      files[existing].added += diff.added;
      files[existing].deleted += diff.deleted;
    }
  }
  return files;
}

function asPresentFiles(value: unknown): Array<{ path: string; description?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const path = (item as { path?: unknown }).path;
    if (typeof path !== 'string' || !path.trim()) return [];
    const description = (item as { description?: unknown }).description;
    return [{ path, ...(typeof description === 'string' ? { description } : {}) }];
  });
}

export function presentedForTurn(segments: TimelineSegment[]): PresentedFile[] {
  const files: PresentedFile[] = [];
  const index = new Map<string, number>();
  for (const segment of segments) {
    if (segment.kind !== 'tool' || segment.toolName.toLowerCase() !== 'present' || segment.status !== 'done') continue;
    const details = getDetails(segment.result);
    for (const file of asPresentFiles(details?.files)) {
      const next = { path: file.path, display: fileNameFromPath(file.path), ...(file.description ? { description: file.description } : {}) };
      const existing = index.get(file.path);
      if (existing === undefined) {
        index.set(file.path, files.length);
        files.push(next);
      } else {
        files[existing] = { ...files[existing], ...next };
      }
    }
  }
  return files;
}

export function resolveWorkspaceFile(cwd: string, path: string): string | null {
  const raw = path.trim();
  if (!cwd.trim() || !raw) return null;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(raw)
    ? raw.replace(/\\/g, '/')
    : `${root}/${raw.replace(/^[\\/]+/, '').replace(/\\/g, '/')}`;
  const normalized = abs.replace(/\/+/g, '/');
  const lower = normalized.toLowerCase();
  const rootLower = root.toLowerCase();
  if (lower !== rootLower && !lower.startsWith(`${rootLower}/`)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}
