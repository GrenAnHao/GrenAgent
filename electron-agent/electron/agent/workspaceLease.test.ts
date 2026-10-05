import { describe, expect, it, vi } from 'vitest';
import { releaseWorkspaceLease, retainWorkspaceLease, __resetWorkspaceLeasesForTest } from './workspaceLease';

describe('workspaceLease', () => {
  it('最后一个 handle 释放时才清理项目资源', async () => {
    __resetWorkspaceLeasesForTest();
    const cleanup = vi.fn(async () => {});
    retainWorkspaceLease('C:/work');
    retainWorkspaceLease('C:/work');
    await releaseWorkspaceLease('C:/work', cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    await releaseWorkspaceLease('C:/work', cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
