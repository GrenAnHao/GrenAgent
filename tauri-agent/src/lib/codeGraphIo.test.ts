import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { getFileGraph, getRichGraph } from './codeGraphIo';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ nodes: [], edges: [], circularPaths: [] });
});

describe('getFileGraph', () => {
  it('invokes code_intel_file_graph with workspace and null limit by default', async () => {
    await getFileGraph('/ws');
    expect(invoke).toHaveBeenCalledWith('code_intel_file_graph', { workspace: '/ws', limit: null });
  });

  it('passes an explicit limit through', async () => {
    await getFileGraph('/ws', 500);
    expect(invoke).toHaveBeenCalledWith('code_intel_file_graph', { workspace: '/ws', limit: 500 });
  });
});

describe('getRichGraph', () => {
  it('invokes code_intel_rich_graph with workspace and null limit by default', async () => {
    await getRichGraph('/ws');
    expect(invoke).toHaveBeenCalledWith('code_intel_rich_graph', { workspace: '/ws', limit: null });
  });

  it('passes an explicit limit through', async () => {
    await getRichGraph('/ws', 1000);
    expect(invoke).toHaveBeenCalledWith('code_intel_rich_graph', { workspace: '/ws', limit: 1000 });
  });

  it('returns the RichGraph from invoke', async () => {
    invoke.mockResolvedValueOnce({
      nodes: [{ path: 'src/a.ts', lines: 0, exportCount: 0, complexity: 0, inDegree: 1 }],
      edges: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 }],
      circularPaths: [],
    });
    const g = await getRichGraph('/workspace');
    expect(g.nodes).toHaveLength(1);
    expect(g.edges[0].kind).toBe('import-value');
  });
});
