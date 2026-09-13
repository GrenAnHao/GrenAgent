import { describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', '..');
const productionRoots = [
  'electron-agent/electron',
  'electron-agent/src',
  'extensions',
  'cli/src',
];
const manifests = [
  'electron-agent/package.json',
  'electron-agent/electron-builder.yml',
  'extensions/package.json',
  'cli/package.json',
];
const forbidden = [
  '@tencentdb-agent-memory',
  'TencentDbService',
  'tencentdb_core_request',
  'TDAI_MEMORY_ENDPOINT',
  'TencentDB extraResources',
];

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ['node_modules', 'dist', 'build', '.runtime', 'target'].includes(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(full));
    else if (!entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) files.push(full);
  }
  return files;
}

describe('TencentDB removal gate', () => {
  test('production sources and manifests contain no TencentDB runtime remnants', async () => {
    const paths = [
      ...(await Promise.all(productionRoots.map((path) => filesUnder(join(root, path))))).flat(),
      ...manifests.map((path) => join(root, path)),
    ];
    const findings: string[] = [];
    for (const path of paths) {
      const text = await readFile(path, 'utf8');
      for (const token of forbidden) {
        if (text.includes(token)) findings.push(`${relative(root, path)}: ${token}`);
      }
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });
});
