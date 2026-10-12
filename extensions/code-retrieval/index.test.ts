import { afterEach, describe, expect, it, vi } from 'vitest';
import codeRetrieval from './index.js';
import { CODE_GRAPH_AGENT_TOOLS } from './tools.js';
import { MemoryClient } from '../memory/client.js';

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, unknown>; required?: string[] };
  execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
}

afterEach(() => vi.restoreAllMocks());

describe('code retrieval extension', () => {
  it('registers CodeGraph tools', () => {
    const tools: string[] = [];
    codeRetrieval({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never);
    expect(tools).toEqual(CODE_GRAPH_AGENT_TOOLS);
  });

  it('tells the model to use code_explore before grep or bash', () => {
    const tools: Array<{ name: string; description: string }> = [];
    codeRetrieval({ registerTool: (tool: { name: string; description: string }) => tools.push(tool), on: () => {} } as never);
    expect(tools.map((tool) => tool.name)).toEqual(['code_explore']);
    expect(tools[0]?.description).toMatch(/prefer over grep or bash/i);
  });

  it('registers promptSnippet and family guidelines only on code_explore', () => {
    const tools: RegisteredTool[] = [];
    codeRetrieval({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    expect(tools.map((tool) => tool.name)).toEqual(CODE_GRAPH_AGENT_TOOLS);
    for (const tool of tools) {
      expect(tool.promptSnippet?.trim()).toBeTruthy();
    }
    const explore = tools.find((tool) => tool.name === 'code_explore');
    expect(explore?.promptGuidelines?.length).toBeGreaterThan(0);
    for (const guideline of explore?.promptGuidelines ?? []) {
      expect(guideline).toMatch(/code_[a-z0-9_*]+/);
      expect(guideline).not.toMatch(/\bthis tool\b/i);
    }
    expect(tools.filter((tool) => tool.name !== 'code_explore' && (tool.promptGuidelines?.length ?? 0) > 0)).toEqual([]);
  });

  it('injects a CodeGraph-first hint when the workspace index exists', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'pi-cg-'));
    mkdirSync(join(cwd, '.codegraph'));
    writeFileSync(join(cwd, '.codegraph', 'codegraph.db'), '');
    const on = vi.fn();
    codeRetrieval({ registerTool: () => {}, on } as never);
    const start = on.mock.calls.find(([name]) => name === 'before_agent_start')?.[1] as
      | ((event: unknown, ctx: { cwd: string }) => unknown)
      | undefined;
    expect(start).toBeTypeOf('function');
    const injected = await start?.({}, { cwd });
    expect(injected).toMatchObject({
      message: { customType: 'codegraph', display: false },
    });
    expect(String((injected as { message: { content: string } }).message.content)).toMatch(/do not start with/i);
    expect(String((injected as { message: { content: string } }).message.content)).toMatch(/code_explore/);
  });

  it('injects a grep/find fallback when the workspace has no index', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'pi-cg-empty-'));
    const on = vi.fn();
    codeRetrieval({ registerTool: () => {}, on } as never);
    const start = on.mock.calls.find(([name]) => name === 'before_agent_start')?.[1] as
      | ((event: unknown, ctx: { cwd: string }) => unknown)
      | undefined;
    expect(start).toBeTypeOf('function');
    const injected = await start?.({}, { cwd });
    expect(injected).toMatchObject({ message: { customType: 'codegraph', display: false } });
    expect(String((injected as { message: { content: string } }).message.content)).toMatch(/no CodeGraph index/i);
    expect(String((injected as { message: { content: string } }).message.content)).toMatch(/grep/);
  });

  it.each([
    ['code_explore', 'codegraph_explore', { query: 'parse', maxFiles: 4 }],
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

  it('exposes only query and maxFiles, and query is required', () => {
    const tools: RegisteredTool[] = [];
    codeRetrieval({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const explore = tools.find((tool) => tool.name === 'code_explore')!;
    expect(Object.keys(explore.parameters.properties).sort()).toEqual(['maxFiles', 'query']);
    expect(explore.parameters.required).toEqual(['query']);
  });
});
