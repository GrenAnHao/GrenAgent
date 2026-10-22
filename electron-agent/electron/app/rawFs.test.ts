import * as nodeFs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rawFs, rawFsPromises } from './rawFs';

describe('rawFs', () => {
  it('普通 Node 里退回 node:fs', () => {
    expect(process.versions.electron).toBeUndefined();
    expect(rawFs).toBe(nodeFs);
    expect(rawFsPromises).toBe(nodeFs.promises);
  });

  // Electron 的 node:fs 对 *.asar 做一次 stat 就打开归档并一直占着，开着 GrenAgent 时 electron-builder 清不掉 release/。
  it('遍历工作区的 FileService 不直接用 node:fs', () => {
    const source = readFileSync(join(__dirname, 'fileService.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
    expect(source).toMatch(/from '\.\/rawFs\.js'/);
  });
});
