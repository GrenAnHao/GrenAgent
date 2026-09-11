import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerEntry } from './workerEntry.js';

describe('resolveWorkerEntry', () => {
  it('开发态用 main chunk 同目录的 pi-worker.js', () => {
    expect(resolveWorkerEntry({ packaged: false, resourcesPath: 'C:/res', mainDir: 'D:/app/out/main' }))
      .toBe(join('D:/app/out/main', 'pi-worker.js'));
  });

  it('打包态用 asarUnpack 下的 pi-worker.js', () => {
    expect(resolveWorkerEntry({ packaged: true, resourcesPath: 'C:/res', mainDir: 'D:/ignored' }))
      .toBe(join('C:/res', 'app.asar.unpacked', 'out', 'main', 'pi-worker.js'));
  });
});
