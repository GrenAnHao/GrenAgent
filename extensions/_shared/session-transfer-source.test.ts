import { describe, expect, it } from 'vitest';
import {
  buildEntryRootProvenance,
  effectiveRecordedCwd,
  historyTransferSources,
  referenceSourceRoot,
  SESSION_PROJECT_TRANSFER_ENTRY,
} from './session-project-transfer.js';

const source = 'D:/old';
const target = 'E:/new';
const entry = (id: string, parentId: string | null, data: Record<string, unknown>) => ({ id, parentId, ...data });
const marker = (id: string, parentId: string | null, fromWorkspace: string, toWorkspace: string, count: number) => entry(id, parentId, {
  type: 'custom', customType: SESSION_PROJECT_TRANSFER_ENTRY,
  data: { version: 1, operationId: id, fromWorkspace, toWorkspace, previousCwd: fromWorkspace,
    leafId: parentId, boundary: { entryCount: count, afterEntryId: parentId },
    history: { version: 1, ref: id }, createdAt: 1 },
});
const cwd = (id: string, parentId: string, path: string) => entry(id, parentId, {
  type: 'custom', customType: 'working_directory', data: { cwd: path },
});
const call = (id: string, parentId: string, toolCallId: string) => entry(id, parentId, {
  type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, arguments: { path: 'src/config.ts' } }] },
});
const result = (id: string, parentId: string, toolCallId: string) => entry(id, parentId, {
  type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'read', isError: false, details: { path: 'src/config.ts' } },
});

describe('session transfer source provenance', () => {
  it('resolves branch A and B independently, never using the last physical cd', () => {
    const rows = [cwd('a', 'start', `${source}/a`), call('aCall', 'a', 'toolA'), result('aResult', 'aCall', 'toolA'),
      cwd('b', 'start', `${source}/b`), call('bCall', 'b', 'toolB'), result('bResult', 'bCall', 'toolB'),
      call('aAgain', 'aResult', 'toolAgain'), result('aAgainResult', 'aAgain', 'toolAgain')];
    const roots = buildEntryRootProvenance([entry('start', null, { type: 'message', message: { role: 'user', content: 'hello' } }), ...rows], source);
    expect(referenceSourceRoot(roots, 'aResult', 'path')).toBe(`${source}/a`);
    expect(referenceSourceRoot(roots, 'bResult', 'path')).toBe(`${source}/b`);
    expect(referenceSourceRoot(roots, 'aAgainResult', 'path')).toBe(`${source}/a`);
  });

  it('resets new entries at transfer boundary even if old confirmed leaf has a cd ancestor', () => {
    const rows = [entry('start', null, { type: 'message' }), cwd('oldCd', 'start', `${source}/old`),
      call('oldCall', 'oldCd', 'before'), result('oldResult', 'oldCall', 'before'),
      marker('moveOne', 'oldResult', source, target, 4), cwd('initial', 'moveOne', target),
      call('newCall', 'oldResult', 'after'), result('newResult', 'newCall', 'after')];
    const roots = historyTransferSources(rows, target)!;
    expect(referenceSourceRoot(roots, 'oldResult', 'path')).toBe(`${source}/old`);
    expect(referenceSourceRoot(roots, 'newResult', 'path')).toBe(target);
    expect(effectiveRecordedCwd(rows, target, 'oldResult')).toBe(target);
    expect(effectiveRecordedCwd(rows, target, 'newResult')).toBe(target);
  });

  it('keeps the first source over a round-trip and isolates later directory segments', () => {
    const rows = [entry('start', null, { type: 'message' }), call('firstCall', 'start', 'first'), result('firstResult', 'firstCall', 'first'),
      marker('moveOne', 'firstResult', source, target, 3), cwd('initial', 'moveOne', target),
      call('middleCall', 'firstResult', 'middle'), result('middleResult', 'middleCall', 'middle'),
      marker('moveTwo', 'middleResult', target, source, 7), cwd('secondInitial', 'moveTwo', source),
      call('lastCall', 'middleResult', 'last'), result('lastResult', 'lastCall', 'last')];
    const roots = historyTransferSources(rows, source)!;
    expect(referenceSourceRoot(roots, 'firstResult', 'path')).toBe(source);
    expect(referenceSourceRoot(roots, 'middleResult', 'path')).toBe(target);
    expect(referenceSourceRoot(roots, 'lastResult', 'path')).toBe(source);
  });
});
