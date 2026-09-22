export type TruncateMode = 'drop-target' | 'keep-target';

export type TruncateSessionResult =
  | { ok: true; lines: string[] }
  | { ok: false; reason: 'branched' };

type SessionLine = {
  type: string;
  id?: string;
  parentId?: string | null;
};

function parseLine(line: string): SessionLine {
  return JSON.parse(line) as SessionLine;
}

/** Session header is not part of the parentId tree; all other id+parentId rows are. */
function isSessionTreeEntry(parsed: SessionLine): parsed is SessionLine & { id: string; parentId: string | null } {
  if (parsed.type === 'session') return false;
  if (parsed.id == null) return false;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'parentId')) return false;
  return true;
}

function collectDescendantIds(lines: string[], targetId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!isSessionTreeEntry(parsed) || parsed.parentId == null) continue;
    const siblings = childrenByParent.get(parsed.parentId) ?? [];
    siblings.push(parsed.id);
    childrenByParent.set(parsed.parentId, siblings);
  }

  const descendants = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const childId of childrenByParent.get(id) ?? []) {
      if (descendants.has(childId)) continue;
      descendants.add(childId);
      queue.push(childId);
    }
  }
  return descendants;
}

function findTargetIndex(lines: string[], targetId: string): number {
  return lines.findIndex((line) => {
    const parsed = parseLine(line);
    return isSessionTreeEntry(parsed) && parsed.id === targetId;
  });
}

export function truncateSessionLines(
  lines: string[],
  targetId: string,
  mode: TruncateMode,
): TruncateSessionResult {
  const targetIndex = findTargetIndex(lines, targetId);
  if (targetIndex < 0) {
    return { ok: true, lines: [...lines] };
  }

  const descendants = collectDescendantIds(lines, targetId);

  for (let i = targetIndex + 1; i < lines.length; i++) {
    const parsed = parseLine(lines[i]!);
    if (!isSessionTreeEntry(parsed)) continue;
    if (parsed.id !== targetId && !descendants.has(parsed.id)) {
      return { ok: false, reason: 'branched' };
    }
  }

  const removeIds = new Set(descendants);
  if (mode === 'drop-target') {
    removeIds.add(targetId);
  }

  const nextLines = lines.filter((line) => {
    const parsed = parseLine(line);
    if (!isSessionTreeEntry(parsed)) return true;
    return !removeIds.has(parsed.id);
  });

  return { ok: true, lines: nextLines };
}
