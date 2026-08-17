import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connection, coreRequest, reloadSkills } = vi.hoisted(() => ({
  connection: {
    config: { agentId: 'agent-current' },
    status: { state: 'ready' },
  },
  coreRequest: vi.fn(),
  reloadSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock('./tencentdbApi', () => ({
  tencentdbApi: { coreRequest, reloadSkills },
  useTencentdbConnection: () => connection,
}));

import { AgentLoadout } from './AgentLoadout';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  connection.config = { agentId: 'agent-current' };
  connection.status = { state: 'ready' };
  coreRequest.mockImplementation((route: string) => {
    if (route === '/v3/meta/asset/list-accessible') {
      return Promise.resolve({ items: [
        { asset_id: 'skill-1', asset_type: 'skill', name: 'Review' },
        { asset_id: 'wiki-1', asset_type: 'llm_wiki', name: 'Docs' },
        { asset_id: 'memory-1', asset_type: 'chat_memory', name: 'Memory' },
      ], total: 3 });
    }
    if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
      return Promise.resolve({
        agent: { agent_id: 'agent-current' },
        items: [
          { asset_id: 'wiki-1', asset_type: 'llm_wiki', name: 'Docs', injection_mode: 'summary', priority: 7 },
          { asset_id: 'memory-1', asset_type: 'chat_memory', name: 'Memory', injection_mode: 'direct', priority: 10 },
          { asset_id: 'shared-skill', asset_type: 'skill', name: 'Shared', injection_mode: 'reference', priority: 4 },
        ],
        total: 3,
      });
    }
    return Promise.resolve({});
  });
});

describe('AgentLoadout', () => {
  it('manages only the configured agent and preserves existing binding settings', async () => {
    render(<AgentLoadout />);
    expect(await screen.findByText('agent-current')).toBeTruthy();
    expect(screen.queryByText('编码代理')).toBeNull();
    expect(screen.queryByText('Memory')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Shared/ })).toBeChecked();

    expect(screen.getByRole('checkbox', { name: /Docs/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Review/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存装备' }));

    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/meta/agent-fixed-asset/set', {
      bindings: expect.arrayContaining([
        { asset_id: 'skill-1', asset_type: 'skill', injection_mode: 'direct', priority: 0 },
        { asset_id: 'wiki-1', asset_type: 'llm_wiki', injection_mode: 'summary', priority: 7 },
        { asset_id: 'memory-1', asset_type: 'chat_memory', injection_mode: 'direct', priority: 10 },
        { asset_id: 'shared-skill', asset_type: 'skill', injection_mode: 'reference', priority: 4 },
      ]),
    }));
    expect(coreRequest.mock.calls.find(([route]) => route === '/v3/meta/agent-fixed-asset/set')?.[1].bindings).toHaveLength(4);
    expect(reloadSkills).toHaveBeenCalledTimes(1);
  });

  it('shows empty and error states with retry', async () => {
    coreRequest.mockRejectedValueOnce(new Error('metadata down'));
    render(<AgentLoadout />);
    expect(await screen.findByRole('alert')).toHaveTextContent('metadata down');
    coreRequest.mockResolvedValue({ items: [] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('暂无可装备的 Skill、Wiki 或 CodeGraph 资产')).toBeTruthy();
  });

  it('persists edited mode and priority for a newly selected asset', async () => {
    render(<AgentLoadout />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Review/ }));
    fireEvent.mouseDown(screen.getByLabelText('Review 注入模式'));
    fireEvent.click((await screen.findAllByText('reference')).at(-1)!);
    fireEvent.change(screen.getByLabelText('Review 优先级'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存装备' }));

    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith(
      '/v3/meta/agent-fixed-asset/set',
      expect.objectContaining({
        bindings: expect.arrayContaining([
          { asset_id: 'skill-1', asset_type: 'skill', injection_mode: 'reference', priority: 5 },
        ]),
      }),
    ));
  });

  it('loads every fixed-asset page and preserves the 101st non-managed binding', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      asset_id: `memory-${index}`,
      asset_type: 'chat_memory',
      name: `Memory ${index}`,
      injection_mode: 'direct',
      priority: index,
    }));
    const lastBinding = {
      asset_id: 'memory-100',
      asset_type: 'chat_memory',
      name: 'Memory 100',
      injection_mode: 'direct',
      priority: 100,
    };
    coreRequest.mockImplementation((route: string, body?: { offset?: number }) => {
      if (route === '/v3/meta/asset/list-accessible') return Promise.resolve({ items: [], total: 0 });
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        return body?.offset === 100
          ? Promise.resolve({ items: [lastBinding], total: 101 })
          : Promise.resolve({ items: firstPage, total: 101 });
      }
      return Promise.resolve({});
    });

    render(<AgentLoadout />);
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith(
      '/v3/meta/agent-fixed-asset/list-with-detail',
      { limit: 100, offset: 100 },
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存装备' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '保存装备' }));

    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith(
      '/v3/meta/agent-fixed-asset/set',
      expect.objectContaining({
        bindings: expect.arrayContaining([{
          asset_id: 'memory-100',
          asset_type: 'chat_memory',
          injection_mode: 'direct',
          priority: 100,
        }]),
      }),
    ));
    const payload = coreRequest.mock.calls.find(([route]) => route === '/v3/meta/agent-fixed-asset/set')?.[1];
    expect(payload.bindings).toHaveLength(101);
  });

  it('loads every accessible asset page so the 101st managed asset can be equipped', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      asset_id: `skill-${index}`,
      asset_type: 'skill',
      name: `Skill ${index}`,
    }));
    const lastAsset = {
      asset_id: 'skill-100',
      asset_type: 'skill',
      name: 'Skill 100',
    };
    coreRequest.mockImplementation((route: string, body?: { offset?: number }) => {
      if (route === '/v3/meta/asset/list-accessible') {
        return body?.offset === 100
          ? Promise.resolve({ items: [lastAsset], total: 101 })
          : Promise.resolve({ items: firstPage, total: 101 });
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.resolve({});
    });

    render(<AgentLoadout />);

    expect(await screen.findByRole('checkbox', { name: 'Skill 100' })).toBeTruthy();
    expect(coreRequest).toHaveBeenCalledWith('/v3/meta/asset/list-accessible', {
      limit: 100,
      offset: 100,
    });
  });

  it('loads team-shared assets from the permission-filtered accessible catalog', async () => {
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/meta/asset/list-accessible') {
        return Promise.resolve({
          items: [{ asset_id: 'skill-shared', asset_type: 'skill', name: 'Shared team skill', visibility: 'team' }],
          total: 1,
        });
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });

    render(<AgentLoadout />);

    expect(await screen.findByRole('checkbox', { name: 'Shared team skill' })).toBeTruthy();
    expect(coreRequest).toHaveBeenCalledWith('/v3/meta/asset/list-accessible', {
      limit: 100,
      offset: 0,
    });
    expect(coreRequest.mock.calls.some(([route]) => route === '/v3/meta/asset/list')).toBe(false);
  });

  it('continues both listings after a non-empty short page while total remains', async () => {
    coreRequest.mockImplementation((route: string, body?: { offset?: number }) => {
      const offset = body?.offset ?? 0;
      if (route === '/v3/meta/asset/list-accessible') {
        return Promise.resolve(offset === 0
          ? { items: [{ asset_id: 'skill-1', asset_type: 'skill', name: 'Skill 1' }], total: 2 }
          : { items: [{ asset_id: 'skill-2', asset_type: 'skill', name: 'Skill 2' }], total: 2 });
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        return Promise.resolve(offset === 0
          ? { items: [{ asset_id: 'skill-1', asset_type: 'skill', name: 'Skill 1', injection_mode: 'direct', priority: 1 }], total: 2 }
          : { items: [{ asset_id: 'skill-2', asset_type: 'skill', name: 'Skill 2', injection_mode: 'reference', priority: 2 }], total: 2 });
      }
      return Promise.resolve({});
    });

    render(<AgentLoadout />);

    expect(await screen.findByRole('checkbox', { name: 'Skill 2' })).toBeChecked();
    expect(coreRequest).toHaveBeenCalledWith('/v3/meta/asset/list-accessible', {
      limit: 100,
      offset: 1,
    });
    expect(coreRequest).toHaveBeenCalledWith('/v3/meta/agent-fixed-asset/list-with-detail', {
      limit: 100,
      offset: 1,
    });
  });

  it('isolates a pending save when the configured agent changes', async () => {
    const pendingSave = deferred<Record<string, never>>();
    connection.config = { agentId: 'agent-a' };
    coreRequest.mockImplementation((route: string) => {
      const currentAgent = connection.config.agentId;
      if (route === '/v3/meta/asset/list-accessible') {
        return Promise.resolve({
          items: [{ asset_id: `skill-${currentAgent}`, asset_type: 'skill', name: `Skill ${currentAgent}` }],
          total: 1,
        });
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        return Promise.resolve({
          items: [{
            asset_id: `skill-${currentAgent}`,
            asset_type: 'skill',
            name: `Skill ${currentAgent}`,
            injection_mode: 'direct',
            priority: 1,
          }],
          total: 1,
        });
      }
      if (route === '/v3/meta/agent-fixed-asset/set') return pendingSave.promise;
      return Promise.resolve({});
    });

    const view = render(<AgentLoadout />);
    expect(await screen.findByText('Skill agent-a')).toBeTruthy();
    fireEvent.click(screen.getByText('保存装备').closest('button')!);
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith(
      '/v3/meta/agent-fixed-asset/set',
      expect.any(Object),
    ));

    connection.config = { agentId: 'agent-b' };
    view.rerender(<AgentLoadout />);
    expect(await screen.findByText('Skill agent-b')).toBeTruthy();
    const newAgentSave = screen.getByText('保存装备').closest('button')!;
    const newAgentWasBlocked = newAgentSave.classList.contains('ant-btn-loading');

    await act(async () => {
      pendingSave.reject(new Error('agent-a save failed'));
      await pendingSave.promise.catch(() => undefined);
    });

    expect(newAgentWasBlocked).toBe(false);
    expect(screen.queryByText('agent-a save failed')).toBeNull();
    expect(screen.getByText('Skill agent-b')).toBeTruthy();
  });

  it('switches agents and ignores an older pending reload', async () => {
    const pendingAssets = deferred<{ items: Array<Record<string, unknown>>; total: number }>();
    const pendingBindings = deferred<{ items: Array<Record<string, unknown>>; total: number }>();
    let agentAAssetCalls = 0;
    let agentABindingCalls = 0;
    connection.config = { agentId: 'agent-a' };
    coreRequest.mockImplementation((route: string) => {
      const agentId = connection.config.agentId;
      if (route === '/v3/meta/asset/list-accessible') {
        if (agentId === 'agent-a' && agentAAssetCalls++ > 0) return pendingAssets.promise;
        return Promise.resolve({ items: [{ asset_id: `skill-${agentId}`, asset_type: 'skill', name: `Skill ${agentId}` }], total: 1 });
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        if (agentId === 'agent-a' && agentABindingCalls++ > 0) return pendingBindings.promise;
        return Promise.resolve({
          items: [{ asset_id: `skill-${agentId}`, asset_type: 'skill', name: `Skill ${agentId}`, injection_mode: 'reference', priority: 2 }],
          total: 1,
        });
      }
      return Promise.resolve({});
    });

    const view = render(<AgentLoadout />);
    expect(await screen.findByRole('checkbox', { name: 'Skill agent-a' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(agentAAssetCalls).toBe(2);
      expect(agentABindingCalls).toBe(2);
    });

    connection.config = { agentId: 'agent-b' };
    view.rerender(<AgentLoadout />);
    expect(await screen.findByRole('checkbox', { name: 'Skill agent-b' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Skill agent-a' })).toBeNull();

    await act(async () => {
      pendingAssets.resolve({ items: [{ asset_id: 'skill-stale', asset_type: 'skill', name: 'Skill stale' }], total: 1 });
      pendingBindings.resolve({
        items: [{ asset_id: 'skill-stale', asset_type: 'skill', name: 'Skill stale', injection_mode: 'direct', priority: 9 }],
        total: 1,
      });
      await Promise.resolve();
    });
    expect(screen.queryByRole('checkbox', { name: 'Skill stale' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Skill agent-b' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '保存装备' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/meta/agent-fixed-asset/set', {
      bindings: [{ asset_id: 'skill-agent-b', asset_type: 'skill', injection_mode: 'reference', priority: 2 }],
    }));
  });

  it('ignores a pending reload and hides all assets when disconnected', async () => {
    const view = render(<AgentLoadout />);
    expect(await screen.findByRole('checkbox', { name: /Docs/ })).toBeTruthy();
    const pendingAssets = deferred<{ items: Array<Record<string, unknown>>; total: number }>();
    const pendingBindings = deferred<{ items: Array<Record<string, unknown>>; total: number }>();
    let assetRequested = false;
    let bindingsRequested = false;
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/meta/asset/list-accessible') {
        assetRequested = true;
        return pendingAssets.promise;
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') {
        bindingsRequested = true;
        return pendingBindings.promise;
      }
      return Promise.resolve({});
    });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(assetRequested).toBe(true);
      expect(bindingsRequested).toBe(true);
    });

    connection.status = { state: 'stopped' };
    view.rerender(<AgentLoadout />);
    await act(async () => {
      pendingAssets.resolve({ items: [{ asset_id: 'skill-stale', asset_type: 'skill', name: 'Stale' }], total: 1 });
      pendingBindings.resolve({
        items: [{ asset_id: 'skill-stale', asset_type: 'skill', name: 'Stale', injection_mode: 'direct', priority: 1 }],
        total: 1,
      });
      await Promise.resolve();
    });

    expect(screen.queryByRole('checkbox', { name: /Docs/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Stale' })).toBeNull();
    expect(screen.getByRole('button', { name: '保存装备' })).toBeDisabled();
  });

});
