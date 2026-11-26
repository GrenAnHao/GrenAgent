import { describe, expect, it } from 'vitest';
import {
  collectTransferTargets,
  clearWorkspaceSessionBinding,
  consumeTransferOpen,
  markTransferOpen,
  relocateSession,
  resetTransferOpen,
  transferBusyText,
  transferStaleText,
} from './sessionProjectTransferScope';
import type { SessionInfo } from '../../lib/pi';

const session = (path: string, cwd: string, name = 'x', archived = false): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp: '2026-11-01T00:00:00.000Z',
  name,
  ...(archived ? { archived: true } : {}),
});

describe('session project transfer targets', () => {
  it('lists existing projects, excludes the source, works scratch and archived-only projects', () => {
    const all = [
      session('D:/repo/a.jsonl', 'D:/repo', '源项目会话'),
      session('D:/other/b.jsonl', 'D:/other', '其它项目'),
      session('C:/agent/works/c1/c.jsonl', 'C:/agent/works/c1', '对话'),
      session('D:/arch/d.jsonl', 'D:/arch', '已归档', true),
    ];
    const targets = collectTransferTargets({
      allSessions: all,
      registeredProjects: ['D:/empty', 'D:/repo'],
      worksDir: 'C:/agent/works',
      aliases: { 'D:/other': '别的项目' },
      sourceWorkspace: 'D:\\REPO',
    });
    expect(targets.map((t) => t.cwd)).toEqual(['D:/other', 'D:/empty']);
    expect(targets.find((t) => t.cwd === 'D:/other')).toMatchObject({ name: '别的项目', sessionCount: 1 });
    expect(targets.find((t) => t.cwd === 'D:/empty')).toMatchObject({ sessionCount: 0 });
  });
});

describe('session project transfer projection', () => {
  const sessionPath = 'D:/s/repo/a.jsonl';

  it('moves one session to the target without duplicating the path and keeps id/title/timestamp', () => {
    const before = [session(sessionPath, 'D:/repo', '标题'), session('D:/s/repo/b.jsonl', 'D:/repo', 'B')];
    const after = relocateSession(before, 'd:\\s\\repo\\A.JSONL', 'D:/target');
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ path: sessionPath, cwd: 'D:/target', name: '标题', id: sessionPath });
    expect(after[1].cwd).toBe('D:/repo');
  });

  it('collapses a duplicate entry of the same path instead of showing it twice', () => {
    const before = [session(sessionPath, 'D:/repo'), session(sessionPath, 'D:/target')];
    const after = relocateSession(before, sessionPath, 'D:/target');
    expect(after).toHaveLength(1);
    expect(after[0].cwd).toBe('D:/target');
  });

  it('clears only the source workspace binding for this session', () => {
    const bindings = { 'D:/repo': sessionPath, 'D:/other': 'D:/s/other/x.jsonl' };
    expect(clearWorkspaceSessionBinding(bindings, 'd:\\repo', sessionPath)).toEqual({
      'D:/repo': '',
      'D:/other': 'D:/s/other/x.jsonl',
    });
  });

  it('consumes the transfer-open marker once and only for the target workspace', () => {
    resetTransferOpen();
    markTransferOpen({ sessionPath, sourceWorkspace: 'D:/repo', targetWorkspace: 'D:/target' });
    expect(consumeTransferOpen('D:/other')).toBe(false);
    expect(consumeTransferOpen('D:/target')).toBe(true);
    expect(consumeTransferOpen('D:/target')).toBe(false);
  });

  it('keeps busy reasons readable and map stale reasons to a re-preview prompt', () => {
    expect(transferBusyText('background-jobs')).toContain('后台任务');
    expect(transferBusyText('unknown', '宿主诊断')).toBe('宿主诊断');
    expect(transferStaleText('ticket-expired')).toContain('重新预览');
  });
});
