import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { CodeGraph as Graph } from '@colbymchenry/codegraph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCodeGraphTool } from './codeGraphQuery';

const { CodeGraph } = createRequire(import.meta.url)('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph');
let workspace: string;
let graph: Graph;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'pi-sdk-query-'));
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src/parser.ts'), 'export function parse(value: string): string {\n  return value.trim();\n}\n');
  await writeFile(join(workspace, 'src/main.ts'), "import { parse } from './parser';\nexport function main() { return parse(' example '); }\n");
  await writeFile(join(workspace, 'src/other.ts'), 'export function parse(value: number) { return value + 1; }\n');
  graph = await CodeGraph.init(workspace, { index: false });
  const result = await graph.indexAll();
  expect(result.success).toBe(true);
}, 30000);

afterAll(async () => {
  graph?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('SDK structured queries', () => {
  it('preserves symbol identity, location and signature without parsing Markdown', async () => {
    const result = await executeCodeGraphTool(graph, workspace, 'codegraph_search', { query: 'parse' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.schemaVersion).toBe(1);
    expect(result.structuredContent.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'parse', file: 'src/parser.ts', line: 1, id: expect.any(String), snippet: '(value: string): string' }),
    ]));
    expect(result.content[0].text).toContain('src/parser.ts:1');
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('gets callers and callees as nodes and edges with file disambiguation', async () => {
    const callers = await executeCodeGraphTool(graph, workspace, 'codegraph_callers', { symbol: 'parse', file: 'src/parser.ts' });
    expect(callers.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'main', file: 'src/main.ts' })]));
    expect(callers.structuredContent.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calls' })]));
    const callees = await executeCodeGraphTool(graph, workspace, 'codegraph_callees', { symbol: 'main' });
    expect(callees.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'parse', file: 'src/parser.ts' })]));
  });

  it('returns ambiguous candidates instead of silently picking a namesake', async () => {
    const result = await executeCodeGraphTool(graph, workspace, 'codegraph_node', { symbol: 'parse' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.rows).toHaveLength(2);
    const target = result.structuredContent.rows.find((row) => row.file === 'src/parser.ts')!;
    const exact = await executeCodeGraphTool(graph, workspace, 'codegraph_node', { symbol: target.id, includeCode: true });
    expect(exact.isError).toBe(false);
    expect(exact.content[0].text).toContain('return value.trim()');
  });

  it('supports absolute workspace-local files and source pagination', async () => {
    const result = await executeCodeGraphTool(graph, workspace, 'codegraph_node', { file: join(workspace, 'src/parser.ts'), includeCode: true, offset: 2, limit: 1 });
    expect(result.content[0].text).toContain('2:   return value.trim();');
    expect(result.content[0].text).not.toContain('1: export');
  });

  it('lists indexed files with directory and glob filters', async () => {
    const result = await executeCodeGraphTool(graph, workspace, 'codegraph_files', { path: 'src', pattern: '**/parser.ts', format: 'flat' });
    expect(result.structuredContent.rows).toEqual([expect.objectContaining({ file: 'src/parser.ts' })]);
    const missing = await executeCodeGraphTool(graph, workspace, 'codegraph_search', { query: 'definitely_absent_12984' });
    expect(missing.isError).toBe(false);
    expect(missing.structuredContent.rows).toEqual([]);
  });

  describe('paged file listing', () => {
    const files = async (args: Record<string, unknown>) => {
      const result = await executeCodeGraphTool(graph, workspace, 'codegraph_files', { format: 'flat', ...args });
      return { files: result.structuredContent.rows.map((row) => row.file), page: result.structuredContent.extra?.page };
    };

    it('returns one page and reports where it starts and how many files match in total', async () => {
      expect(await files({ limit: 2 })).toEqual({ files: ['src/main.ts', 'src/other.ts'], page: { offset: 0, total: 3 } });
      expect(await files({ limit: 2, offset: 2 })).toEqual({ files: ['src/parser.ts'], page: { offset: 2, total: 3 } });
    });

    it('returns an empty page, not an error, past the end', async () => {
      expect(await files({ limit: 2, offset: 10 })).toEqual({ files: [], page: { offset: 10, total: 3 } });
    });

    it('keeps returning every file when no limit is given, and still reports the total', async () => {
      expect(await files({})).toEqual({ files: ['src/main.ts', 'src/other.ts', 'src/parser.ts'], page: { offset: 0, total: 3 } });
    });

    it('applies path and glob filters before paging, so the total counts only the matches', async () => {
      expect(await files({ pattern: '**/p*.ts', limit: 1 })).toEqual({ files: ['src/parser.ts'], page: { offset: 0, total: 1 } });
    });

    it('caps one page at 500 files however large a limit is asked for', async () => {
      const many = Array.from({ length: 700 }, (_, index) => ({ path: `src/f${String(index).padStart(4, '0')}.ts`, language: 'typescript', nodeCount: 1, size: 10, generated: false }));
      const fake = { getFiles: () => many } as unknown as Graph;
      const result = await executeCodeGraphTool(fake, workspace, 'codegraph_files', { limit: 200 });
      expect(result.structuredContent.rows).toHaveLength(200);
      const capped = await executeCodeGraphTool(fake, workspace, 'codegraph_files', { limit: 9999 });
      expect(capped.structuredContent.rows).toHaveLength(500);
      expect(capped.structuredContent.extra).toEqual({ page: { offset: 0, total: 700 } });
    });
  });

  it('serializes impact and context subgraphs rather than losing Maps', async () => {
    const impact = await executeCodeGraphTool(graph, workspace, 'codegraph_impact', { symbol: 'parse', file: 'src/parser.ts' });
    expect(impact.structuredContent.nodes.some((node) => node.name === 'main')).toBe(true);
    const context = await executeCodeGraphTool(graph, workspace, 'codegraph_explore', { query: 'parse main', maxFiles: 2 });
    expect(context.structuredContent.nodes.length).toBeGreaterThan(0);
    expect(new Set(context.structuredContent.rows.map((row) => row.file)).size).toBeLessThanOrEqual(2);
    expect(JSON.parse(JSON.stringify(context)).structuredContent.nodes.length).toBeGreaterThan(0);
  });

  it('rejects filesystem reads outside the workspace', async () => {
    await expect(executeCodeGraphTool(graph, workspace, 'codegraph_node', { file: '../outside.ts', includeCode: true })).rejects.toThrow(/workspace/i);
  });

  it('rejects a workspace-local junction that points to external source', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pi-sdk-outside-'));
    const link = join(workspace, 'external');
    try {
      await writeFile(join(outside, 'private.ts'), 'private source');
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(executeCodeGraphTool(graph, workspace, 'codegraph_node', { file: 'external/private.ts', includeCode: true })).rejects.toThrow(/workspace/i);
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('forwards SearchOptions and lookup modes to the SDK', async () => {
    const filtered = await executeCodeGraphTool(graph, workspace, 'codegraph_search', {
      query: 'parse', kinds: ['function'], languages: ['typescript'], includePatterns: ['**/parser.ts'],
    });
    expect(filtered.structuredContent.rows).toEqual([expect.objectContaining({ symbol: 'parse', file: 'src/parser.ts' })]);
    const byKind = await executeCodeGraphTool(graph, workspace, 'codegraph_search', { mode: 'kind', kinds: ['function'] });
    expect(byKind.structuredContent.rows.every((row) => row.kind === 'function')).toBe(true);
    expect(byKind.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'parse' })]));
    const prefix = await executeCodeGraphTool(graph, workspace, 'codegraph_search', { query: 'mai', mode: 'prefix' });
    expect(prefix.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'main' })]));
  });

  it('forwards FindRelevantContextOptions instead of only limit', async () => {
    const result = await executeCodeGraphTool(graph, workspace, 'codegraph_explore', {
      query: 'parse', searchLimit: 5, traversalDepth: 2, maxNodes: 12, minScore: 0, nodeKinds: ['function'], edgeKinds: ['calls'],
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.nodes.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(result)).structuredContent.nodes.length).toBeGreaterThan(0);
  });

  it('exposes the remaining SDK query methods with serializable results', async () => {
    const usages = await executeCodeGraphTool(graph, workspace, 'codegraph_usages', { symbol: 'parse', file: 'src/parser.ts' });
    expect(usages.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'main', file: 'src/main.ts' })]));

    const path = await executeCodeGraphTool(graph, workspace, 'codegraph_path', {
      from: 'main', to: 'parse', fromFile: 'src/main.ts', toFile: 'src/parser.ts', edgeKinds: ['calls'],
    });
    expect(path.structuredContent.rows.map((row) => row.symbol)).toEqual(expect.arrayContaining(['main', 'parse']));

    const deps = await executeCodeGraphTool(graph, workspace, 'codegraph_deps', { file: 'src/main.ts', direction: 'dependencies' });
    expect(deps.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'src/parser.ts' })]));

    const status = await executeCodeGraphTool(graph, workspace, 'codegraph_status', {});
    expect(status.structuredContent.extra).toMatchObject({ stats: expect.objectContaining({ fileCount: expect.any(Number) }) });
    expect((status.structuredContent.extra?.stats as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(3);

    const metrics = await executeCodeGraphTool(graph, workspace, 'codegraph_metrics', { symbol: 'parse', file: 'src/parser.ts' });
    expect(metrics.structuredContent.extra).toMatchObject({ metrics: expect.objectContaining({ incomingEdgeCount: expect.any(Number) }) });

    const node = await executeCodeGraphTool(graph, workspace, 'codegraph_node', { symbol: 'parse', file: 'src/parser.ts', includeMetrics: true });
    expect(node.structuredContent.extra).toMatchObject({ metrics: expect.objectContaining({ callerCount: expect.any(Number) }) });

    const graphView = await executeCodeGraphTool(graph, workspace, 'codegraph_call_graph', { symbol: 'main', depth: 2 });
    expect(graphView.structuredContent.nodes.some((entry) => entry.name === 'parse')).toBe(true);

    const traverse = await executeCodeGraphTool(graph, workspace, 'codegraph_traverse', {
      symbol: 'main', direction: 'outgoing', maxDepth: 2, edgeKinds: ['calls'], includeStart: true,
    });
    expect(traverse.structuredContent.nodes.some((entry) => entry.name === 'main' || entry.name === 'parse')).toBe(true);

    const context = await executeCodeGraphTool(graph, workspace, 'codegraph_context', {
      query: 'parse', maxNodes: 8, maxCodeBlocks: 2, includeCode: false,
    });
    expect(context.isError).toBe(false);
    expect(() => JSON.stringify(context)).not.toThrow();
    expect(context.structuredContent.nodes.length + context.structuredContent.rows.length).toBeGreaterThan(0);
    expect(context.content[0].text).toMatch(/parse/i);
    const formatted = await executeCodeGraphTool(graph, workspace, 'codegraph_context', { query: 'parse', format: 'markdown', maxNodes: 8 });
    expect(formatted.content[0].text.length).toBeGreaterThan(10);

    for (const [tool, args] of [
      ['codegraph_hierarchy', { symbol: 'parse', file: 'src/parser.ts' }],
      ['codegraph_cycles', {}],
      ['codegraph_dead_code', { kinds: ['function'] }],
      ['codegraph_routes', { limit: 10 }],
      ['codegraph_changed', {}],
    ] as const) {
      const result = await executeCodeGraphTool(graph, workspace, tool, args);
      expect(result.isError).toBe(false);
      expect(() => JSON.stringify(result)).not.toThrow();
    }
  });
});
