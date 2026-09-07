import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraphService } from './codeGraphService';

let root: string;
let service: CodeGraphService;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-sdk-service-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/parser.ts'), 'export function parse(value: string) { return value.trim(); }\n');
  await writeFile(join(root, 'src/main.ts'), "import { parse } from './parser';\nexport function main() { return parse('a'); }\n");
  service = new CodeGraphService({ listWorkspaces: () => [root] });
});
afterAll(async () => { await service?.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe('embedded CodeGraph AgentData service', () => {
  it('reports a missing index without creating it or starting a CLI', async () => {
    expect(service.projects()).toEqual([{ workspace: root, indexed: false }]);
    expect(await service.status(root)).toMatchObject({ indexed: false, connected: false, sdkAvailable: true });
    await expect(service.call(root, 'codegraph_search', { query: 'parse' })).rejects.toThrow(/not initialized/i);
    expect(await service.search(root, 'parse', 10)).toMatchObject({ available: false, results: [] });
    await expect(stat(join(root, '.codegraph'))).rejects.toThrow();
  });

  it('indexes using the bundled SDK and returns shared structured search results', async () => {
    const phases: string[] = [];
    await service.runSync('init', root, ({ phase }) => phases.push(phase));
    expect(phases).toContain('parsing');
    expect(await service.status(root)).toMatchObject({ connected: true, indexed: true, sdkVersion: '1.6.0', files: 2, state: 'indexed' });
    expect(await service.search(root, 'parse', 10)).toMatchObject({ available: true, results: expect.arrayContaining([expect.objectContaining({ symbol: 'parse', file: 'src/parser.ts', line: 1 })]) });
    const callers = await service.call(root, 'codegraph_callers', { symbol: 'parse', file: 'src/parser.ts' });
    expect(callers.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'main' })]));
  }, 30000);

  it('syncs modified source in place without deleting the workspace', async () => {
    const before = await readFile(join(root, 'src/parser.ts'), 'utf8');
    await writeFile(join(root, 'src/parser.ts'), `${before}export function addedBySync() { return 7; }\n`);
    await service.runSync('sync', root);
    expect((await service.search(root, 'addedBySync', 10)).results).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'addedBySync' })]));
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toContain("parse('a')");
  }, 30000);

  it('keeps operation and workspace restrictions at the service seam', async () => {
    await expect(service.call(root, 'codegraph_sync' as never, {})).rejects.toThrow(/tool/i);
    await expect(service.call(root, 'codegraph_search', { query: 'parse', projectPath: join(root, 'other') })).rejects.toThrow(/projectPath/);
    await expect(service.call(root, 'codegraph_node', { file: '../private.ts' })).rejects.toThrow(/file/);
  });
});
