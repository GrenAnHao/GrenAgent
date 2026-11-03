import { describe, expect, it, vi } from 'vitest';
import { createGrenRepoWikiClient, type GrenRuntimeBridge } from '../../../vendor/repo-wiki/packages/renderer/src/index';

describe('Repo Wiki renderer subscription lifecycle', () => {
  it('releases a subscription acquired after the panel already unmounted and never forwards late events', async () => {
    let ready!: (off: () => void) => void;
    let deliver!: (event: { payload: unknown }) => void;
    const off = vi.fn();
    const runtime = {
      invoke: vi.fn(),
      subscribe: (_event: string, handler: typeof deliver) => {
        deliver = handler;
        return new Promise<() => void>((resolve) => { ready = resolve; });
      },
    } as GrenRuntimeBridge;
    const handler = vi.fn();
    const dispose = createGrenRepoWikiClient(runtime).subscribe(handler);
    dispose();
    ready(off);
    await Promise.resolve();
    deliver({ payload: { project_id: 'forest', run: { status: 'completed' } } });
    expect(off).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates requests without forwarding renderer supplied authorization fields', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const client = createGrenRepoWikiClient({ invoke, subscribe: vi.fn() });
    await expect(client.invoke('create', { path: '/workspace', allowedRoots: ['/'] } as never)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await client.invoke('projects', {});
    expect(invoke).toHaveBeenCalledWith('repoWiki_projects', {});
  });
});
