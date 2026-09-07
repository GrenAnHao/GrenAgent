import { afterEach, describe, expect, it, vi } from 'vitest';
import codeRetrieval from './index.js';
import { MemoryClient } from '../memory/client.js';

interface RegisteredTool {
  name: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
}

afterEach(() => vi.restoreAllMocks());

describe('code retrieval extension', () => {
  it('registers CodeGraph tools', () => {
    const tools: string[] = [];
    codeRetrieval({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never);
    expect(tools).toEqual(['code_search', 'code_explore', 'code_callers', 'code_callees', 'code_impact', 'code_node', 'code_files']);
  });

  it.each([
    ['code_search', 'codegraph_search', { query: 'parse', limit: 5 }],
    ['code_explore', 'codegraph_explore', { query: 'parse' }],
    ['code_callers', 'codegraph_callers', { symbol: 'parse' }],
    ['code_callees', 'codegraph_callees', { symbol: 'parse' }],
    ['code_impact', 'codegraph_impact', { symbol: 'parse', depth: 2 }],
    ['code_node', 'codegraph_node', { file: 'src/parser.ts', offset: 2, limit: 10 }],
    ['code_files', 'codegraph_files', { path: 'src', pattern: '**/*.ts' }],
  ])('sends %s through the AgentData RPC and keeps the raw result', async (name, remote, params) => {
    const raw = { content: [{ type: 'text', text: 'result' }], structuredContent: { nodes: [1] }, isError: true };
    const request = vi.spyOn(MemoryClient.prototype, 'request').mockResolvedValue(raw);
    const tools: RegisteredTool[] = [];
    codeRetrieval({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const tool = tools.find((item) => item.name === name)!;
    const result = await tool.execute('call', params, undefined, undefined, { cwd: '/repo' });
    expect(request).toHaveBeenCalledWith('codeRetrieval.call', { workspace: '/repo', tool: remote, args: params });
    expect(result).toEqual({ content: raw.content, details: raw });
  });

  it('exposes node file mode without requiring a symbol', () => {
    const tools: RegisteredTool[] = [];
    codeRetrieval({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const node = tools.find((tool) => tool.name === 'code_node')!;
    expect(node.parameters.properties).toHaveProperty('file');
    expect(node.parameters.properties).toHaveProperty('offset');
    expect(node.parameters.required ?? []).not.toContain('symbol');
  });
});
