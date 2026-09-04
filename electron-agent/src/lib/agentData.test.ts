import { describe, expect, it, vi } from 'vitest';
import { agentDataApi } from './agentData';
import * as runtime from '../platform/runtime';

describe('agentDataApi', () => {
  it('uses typed IPC commands', async () => { const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({ state: 'ready', version: 1 }); await agentDataApi.status(); expect(spy).toHaveBeenCalledWith('agentData_status'); spy.mockRestore(); });

  it('exposes typed module queries and job creation', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    await agentDataApi.memory.overview({ userId: 'u', workspace: '/w' });
    await agentDataApi.wiki.overview('/w');
    await agentDataApi.code.status('/w');
    await agentDataApi.jobs.create({ kind: 'wiki.sync', workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(1, 'agentData_memory_overview', { userId: 'u', workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(2, 'agentData_wiki_overview', { workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(3, 'agentData_code_status', { workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(4, 'agentData_jobs_create', { kind: 'wiki.sync', workspace: '/w' });
    await agentDataApi.memory.overview({ userId: 'u', includeOtherProjects: true });
    expect(spy).toHaveBeenLastCalledWith('agentData_memory_overview', { userId: 'u', includeOtherProjects: true });
    spy.mockRestore();
  });
});
