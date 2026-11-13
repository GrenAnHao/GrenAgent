import { describe, expect, it, vi } from 'vitest';
import factory from './index.js';

describe('web-search registration', () => {
  it('registers only web_search(query, maxResults)', () => {
    const tools = new Map<string, { parameters: { properties: Record<string, { description?: string }> } }>();
    factory({ registerTool: (tool: { name: string; parameters: never }) => tools.set(tool.name, tool as never) } as never);

    expect(Object.keys(tools.get('web_search')!.parameters.properties).sort()).toEqual(['maxResults', 'query']);
    expect(tools.has("web_search_multi")).toBe(false);
  });

  it('does not gate the search on a desktop preflight that the host no longer serves', async () => {
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    factory({ registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool) } as never);

    const result = await tools.get('web_search')!.execute('call-1', { query: 'Pi agent' }, undefined);

    // 失败文案只能来自搜索引擎链路；权限文案已经不该出现。
    expect(String(result.content?.[0]?.text ?? '')).not.toContain('权限策略');
    fetchSpy.mockRestore();
  });
});
