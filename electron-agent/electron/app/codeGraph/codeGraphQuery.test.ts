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
});
