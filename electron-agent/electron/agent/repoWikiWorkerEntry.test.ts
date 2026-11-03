import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entries from './workerEntry';

describe('RepoWiki bundled child entry', () => {
  it('resolves the CJS child beside dev main and outside production asar', () => {
    const resolve = (entries as any).resolveRepoWikiHostEntry;
    expect(resolve).toBeTypeOf('function');
    expect(resolve({ packaged: false, resourcesPath: 'C:/res', mainDir: 'D:/app/out/main' })).toBe(join('D:/app/out/main', 'repo-wiki-host.cjs'));
    expect(resolve({ packaged: true, resourcesPath: 'C:/res', mainDir: 'D:/ignored' })).toBe(join('C:/res', 'app.asar.unpacked', 'out', 'main', 'repo-wiki-host.cjs'));
  });
});
