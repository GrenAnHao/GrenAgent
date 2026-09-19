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

  it('tells the model to use CodeGraph before bash or grep', () => {
    const tools: Array<{ name: string; description: string }> = [];
    codeRetrieval({ registerTool: (tool: { name: string; description: string }) => tools.push(tool), on: () => {} } as never);
    expect(tools.find((tool) => tool.name === 'code_search')?.description).toMatch(/before bash|prefer over grep/i);
    expect(tools.find((tool) => tool.name === 'code_explore')?.description).toMatch(/before bash|prefer over grep/i);
  });

  it('registers promptSnippet on every CodeGraph tool and family guidelines only on code_explore', () => {
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
    expect(String((injected as { message: { content: string } }).message.content)).toMatch(/code_\*/);
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
    ['code_search', 'codegraph_search', { query: 'parse', limit: 5 }],
    ['code_explore', 'codegraph_explore', { query: 'parse' }],
    ['code_callers', 'codegraph_callers', { symbol: 'parse' }],
    ['code_callees', 'codegraph_callees', { symbol: 'parse' }],
    ['code_impact', 'codegraph_impact', { symbol: 'parse', depth: 2 }],
    ['code_node', 'codegraph_node', { file: 'src/parser.ts', offset: 2, limit: 10 }],
    ['code_files', 'codegraph_files', { path: 'src', pattern: '**/*.ts' }],
    ['code_status', 'codegraph_status', {}],
    ['code_usages', 'codegraph_usages', { symbol: 'parse' }],
    ['code_path', 'codegraph_path', { from: 'main', to: 'parse' }],
    ['code_context', 'codegraph_context', { query: 'parse', format: 'markdown' }],
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
    expect(node.parameters.properties).toHaveProperty('includeMetrics');
    expect(node.parameters.required ?? []).not.toContain('symbol');
  });

  it('exposes full SDK search, explore and files parameters', () => {
    const tools: RegisteredTool[] = [];
    codeRetrieval({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const search = tools.find((tool) => tool.name === 'code_search')!;
    const explore = tools.find((tool) => tool.name === 'code_explore')!;
    const files = tools.find((tool) => tool.name === 'code_files')!;
    for (const key of ['kinds', 'languages', 'includePatterns', 'excludePatterns', 'offset', 'caseSensitive', 'mode', 'words']) {
      expect(search.parameters.properties).toHaveProperty(key);
    }
    for (const key of ['searchLimit', 'traversalDepth', 'maxNodes', 'minScore', 'edgeKinds', 'nodeKinds', 'seedNames']) {
      expect(explore.parameters.properties).toHaveProperty(key);
    }
    for (const key of ['format', 'includeMetadata', 'maxDepth']) {
      expect(files.parameters.properties).toHaveProperty(key);
    }
  });
});
