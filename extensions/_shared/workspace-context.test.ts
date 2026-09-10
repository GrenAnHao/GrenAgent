import { describe, expect, it } from 'vitest';
import { currentCwd, currentWorkspaceContext, resolveToolOrigin, runInWorkspace, type WorkspaceContext } from './workspace-context.js';

const ctx = (over: Partial<WorkspaceContext> = {}): WorkspaceContext => ({
  origin: 'main', workspace: 'D:/proj', cwd: 'D:/proj', config: {}, ...over,
});

describe('workspace-context', () => {
  it('run 内可读到 store，run 外为 undefined', () => {
    expect(currentWorkspaceContext()).toBeUndefined();
    runInWorkspace(ctx(), () => {
      expect(currentWorkspaceContext()?.workspace).toBe('D:/proj');
    });
    expect(currentWorkspaceContext()).toBeUndefined();
  });

  it('嵌套 run 内层覆盖外层', () => {
    runInWorkspace(ctx({ workspace: 'A', cwd: 'A' }), () => {
      runInWorkspace(ctx({ workspace: 'B', cwd: 'B' }), () => {
        expect(currentWorkspaceContext()?.workspace).toBe('B');
      });
      expect(currentWorkspaceContext()?.workspace).toBe('A');
    });
  });

  it('store 穿透 await 链与 setTimeout（方案前提）', async () => {
    await runInWorkspace(ctx({ workspace: 'X' }), async () => {
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 1));
      expect(currentWorkspaceContext()?.workspace).toBe('X');
    });
  });

  it('currentCwd 在 run 外回退 process.cwd()', () => {
    expect(currentCwd()).toBe(process.cwd());
    runInWorkspace(ctx({ cwd: 'D:/other' }), () => {
      expect(currentCwd()).toBe('D:/other');
    });
  });

  it('resolveToolOrigin：ALS origin 优先', () => {
    runInWorkspace(ctx({ origin: 'goal' }), () => {
      expect(resolveToolOrigin()).toBe('goal');
    });
  });

  it('resolveToolOrigin：无 ALS 且 PI_IS_SUBAGENT=1 → subagent，否则 main', () => {
    const prev = process.env.PI_IS_SUBAGENT;
    delete process.env.PI_IS_SUBAGENT;
    expect(resolveToolOrigin()).toBe('main');
    process.env.PI_IS_SUBAGENT = '1';
    expect(resolveToolOrigin()).toBe('subagent');
    if (prev === undefined) delete process.env.PI_IS_SUBAGENT; else process.env.PI_IS_SUBAGENT = prev;
  });
});
