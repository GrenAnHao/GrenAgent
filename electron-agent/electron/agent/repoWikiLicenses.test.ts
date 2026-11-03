import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { readInstalledProductionPackages } = require('../../scripts/collect-third-party-licenses.cjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('installed production license inventory', () => {
  it('includes transitive, peer, scoped and multiple installed versions while excluding dev-only packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gren-license-inventory-'));
    temporaryDirectories.push(root);
    const manifest = async (dir: string, value: object) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify(value));
    };
    await manifest(root, { dependencies: { a: '1', '@scope/b': '1' }, devDependencies: { dev: '1' } });
    await manifest(join(root, 'node_modules/a'), {
      name: 'a', version: '1.0.0', license: 'MIT', dependencies: { shared: '1' },
      peerDependencies: { peer: '*', optionalPeer: '*' },
      peerDependenciesMeta: { optionalPeer: { optional: true } }, optionalDependencies: { absentPlatform: '*' },
    });
    await manifest(join(root, 'node_modules/@scope/b'), { name: '@scope/b', version: '1.0.0', license: 'ISC', dependencies: { shared: '2' } });
    await manifest(join(root, 'node_modules/shared'), { name: 'shared', version: '1.0.0', license: 'MIT' });
    await manifest(join(root, 'node_modules/@scope/b/node_modules/shared'), { name: 'shared', version: '2.0.0', license: 'MIT' });
    await manifest(join(root, 'node_modules/peer'), { name: 'peer', version: '1.0.0', license: 'MIT' });
    await manifest(join(root, 'node_modules/dev'), { name: 'dev', version: '1.0.0', license: 'MIT' });

    const packages = readInstalledProductionPackages(root);
    expect(packages.map((entry: { name: string; version: string }) => `${entry.name}@${entry.version}`).sort()).toEqual([
      '@scope/b@1.0.0', 'a@1.0.0', 'peer@1.0.0', 'shared@1.0.0', 'shared@2.0.0',
    ]);
  });
});
