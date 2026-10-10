import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentHostEntry, resolveJobGuardExe, resolveWorkerEntry } from './workerEntry.js';

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

describe('resolveAgentHostEntry', () => {
  it('开发态用 main chunk 同目录的 agent-host.js', () => {
    expect(resolveAgentHostEntry({ packaged: false, resourcesPath: 'C:/res', mainDir: 'D:/app/out/main' }))
      .toBe(join('D:/app/out/main', 'agent-host.js'));
  });

  it('打包态和 pi-worker 一样从 asarUnpack 加载', () => {
    expect(resolveAgentHostEntry({ packaged: true, resourcesPath: 'C:/res', mainDir: 'D:/ignored' }))
      .toBe(join('C:/res', 'app.asar.unpacked', 'out', 'main', 'agent-host.js'));
  });
});

describe('resolveJobGuardExe', () => {
  it('开发态在 out/main 旁，打包态在 asarUnpack 下', () => {
    expect(resolveJobGuardExe({ packaged: false, resourcesPath: 'C:/res', mainDir: 'D:/app/out/main' }))
      .toBe(join('D:/app/out/main', 'pi-job-guard.exe'));
    expect(resolveJobGuardExe({ packaged: true, resourcesPath: 'C:/res', mainDir: 'D:/ignored' }))
      .toBe(join('C:/res', 'app.asar.unpacked', 'out', 'main', 'pi-job-guard.exe'));
  });
});
