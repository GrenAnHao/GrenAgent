import { describe, expect, it } from 'vitest';
import type { TimelineSegment } from './groupMessages';
import {
  changesForTurn,
  presentedForTurn,
  resolveWorkspaceFile,
  turnSettled,
} from './turnDeliverables';

const write: TimelineSegment = {
  kind: 'tool', id: 'w', toolCallId: 'w1', toolName: 'write',
  args: { path: 'a.txt', content: 'one\ntwo' }, result: { content: [] }, status: 'done',
};
const edit: TimelineSegment = {
  kind: 'tool', id: 'e', toolCallId: 'e1', toolName: 'edit',
  args: { path: 'a.txt', old_string: 'two', new_string: 'TWO\nthree' }, result: { content: [] }, status: 'done',
};
const read: TimelineSegment = {
  kind: 'tool', id: 'r', toolCallId: 'r1', toolName: 'read',
  args: { path: 'a.txt' }, result: { content: [{ type: 'text', text: 'one' }] }, status: 'done',
};
const failed: TimelineSegment = {
  kind: 'tool', id: 'f', toolCallId: 'f1', toolName: 'write',
  args: { path: 'b.txt', content: 'x' }, result: { content: [{ type: 'text', text: 'denied' }] }, status: 'error',
};
const present: TimelineSegment = {
  kind: 'tool', id: 'p', toolCallId: 'p1', toolName: 'present',
  args: { files: [{ path: 'a.txt', description: 'first' }] },
  result: { details: { files: [{ path: 'a.txt', description: 'final note' }] } },
  status: 'done',
};

describe('turnDeliverables', () => {
  it('is unsettled while a tool is running or text is streaming', () => {
    expect(turnSettled([write, { ...edit, status: 'running' }])).toBe(false);
    expect(turnSettled([{ kind: 'text', id: 't', content: 'hi', streaming: true }])).toBe(false);
    expect(turnSettled([{ kind: 'thinking', id: 'th', content: 'hmm', streaming: true }])).toBe(false);
    expect(turnSettled([write, { kind: 'text', id: 't', content: 'hi', streaming: false }])).toBe(true);
  });

  it('merges write+edit on the same path and ignores read/error', () => {
    const files = changesForTurn([write, read, failed, edit]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('a.txt');
    expect(files[0]?.display).toBe('a.txt');
    expect(files[0]?.added).toBe(4);
    expect(files[0]?.deleted).toBe(1);
  });

  it('ignores non-present tools for presentedForTurn', () => {
    expect(presentedForTurn([write])).toEqual([]);
  });

  it('takes the last present description per path', () => {
    const second: TimelineSegment = {
      ...present,
      id: 'p2',
      toolCallId: 'p2',
      result: { details: { files: [{ path: 'a.txt', description: 'override' }, { path: 'b.txt' }] } },
    };
    expect(presentedForTurn([present, second])).toEqual([
      { path: 'a.txt', display: 'a.txt', description: 'override' },
      { path: 'b.txt', display: 'b.txt' },
    ]);
  });

  it('resolves workspace-relative files and rejects escapes', () => {
    expect(resolveWorkspaceFile('D:/ws', 'a.txt')?.replace(/\\/g, '/')).toMatch(/\/a\.txt$/);
    expect(resolveWorkspaceFile('D:/ws', '../secret.txt')).toBeNull();
    expect(resolveWorkspaceFile('D:/ws', 'D:/ws/a.txt')?.replace(/\\/g, '/')).toMatch(/\/a\.txt$/);
  });
});
