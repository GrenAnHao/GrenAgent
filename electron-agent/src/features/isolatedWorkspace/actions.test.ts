import { beforeEach, describe, expect, it, vi } from 'vitest';

const { syncBack } = vi.hoisted(() => ({ syncBack: vi.fn() }));
vi.mock('../../lib/pi', () => ({ pi: { syncBackIsolatedWorkspace: syncBack } }));

import { openReadonlyIfIsolatedGone, syncBackIsolated } from './actions';
import { useIsolatedWorkspaceStore } from '../../stores/isolatedWorkspaceStore';
import { useSessionStore } from '../../store/session';

const W = 'D:/repo/.gren/worktrees/aaa11111';

beforeEach(() => {
  syncBack.mockReset();
  useIsolatedWorkspaceStore.setState({ kinds: {}, dialog: null, revision: 0 });
  useSessionStore.setState({ allSessions: [{ id: 's', path: `${W}/s.jsonl`, cwd: W, timestamp: '1', name: '修登录' }] } as never);
});

describe('openReadonlyIfIsolatedGone', () => {
  it('opens the read-only viewer for a session in a deleted isolated workspace', () => {
    useIsolatedWorkspaceStore.setState({ kinds: { [W]: 'missing' } });
    expect(openReadonlyIfIsolatedGone(W, `${W}/s.jsonl`)).toBe(true);
    expect(useIsolatedWorkspaceStore.getState().dialog).toEqual({ kind: 'viewer', sessionPath: `${W}/s.jsonl`, title: '修登录' });
  });

  it('leaves live isolated workspaces and ordinary projects to the normal switch', () => {
    useIsolatedWorkspaceStore.setState({ kinds: { [W]: 'active' } });
    expect(openReadonlyIfIsolatedGone(W, `${W}/s.jsonl`)).toBe(false);
    expect(openReadonlyIfIsolatedGone('D:/repo', 'D:/repo/x.jsonl')).toBe(false);
    expect(useIsolatedWorkspaceStore.getState().dialog).toBeNull();
  });
});

describe('syncBackIsolated', () => {
  it('reports the parent branch and bumps the revision; reports git errors without the IPC prefix', async () => {
    const message = { success: vi.fn(), error: vi.fn() };
    syncBack.mockResolvedValueOnce({ branch: 'gren/aaa11111', commit: '1234567abcdef' });
    await expect(syncBackIsolated('D:/repo', 'aaa11111', message)).resolves.toBe(true);
    expect(message.success).toHaveBeenCalledWith('已回传：主仓分支 gren/aaa11111 → 1234567');
    expect(useIsolatedWorkspaceStore.getState().revision).toBe(1);

    syncBack.mockRejectedValueOnce(new Error("Error invoking remote method 'gren:invoke': Error: git fetch failed: non-fast-forward"));
    await expect(syncBackIsolated('D:/repo', 'aaa11111', message)).resolves.toBe(false);
    expect(message.error).toHaveBeenCalledWith('回传失败：git fetch failed: non-fast-forward');
  });
});
