import { describe, expect, it, vi } from 'vitest';
import factory from './index.js';

describe('web-search desktop authorization', () => {
  it('does not perform a fetch when Electron denies the network operation', async () => {
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const control = { request: vi.fn(async () => ({ status: 'denied' })) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    factory({ registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool) } as never, control as never);

    const result = await tools.get('web_search')!.execute('call-1', { query: 'Pi agent' }, undefined);

    expect(control.request).toHaveBeenCalledWith('permission.authorize', expect.objectContaining({ operation: expect.objectContaining({ kind: 'network.request', toolName: 'web_search' }) }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.details).toEqual({ error: 'network_denied' });
    fetchSpy.mockRestore();
  });

  it('registers only web_search(query, maxResults)', () => {
    const tools = new Map<string, { parameters: { properties: Record<string, { description?: string }> } }>();
    factory({ registerTool: (tool: { name: string; parameters: never }) => tools.set(tool.name, tool as never) } as never, { request: vi.fn() } as never);

    expect(Object.keys(tools.get('web_search')!.parameters.properties).sort()).toEqual(['maxResults', 'query']);
    expect(tools.has("web_search_multi")).toBe(false);
  });
});
