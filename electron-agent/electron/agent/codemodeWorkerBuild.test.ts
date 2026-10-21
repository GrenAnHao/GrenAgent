import { describe, expect, it } from 'vitest';
import { codemodeWorkerMismatch } from './codemodeWorkerBuild';

const host = '/repo/node_modules/.pnpm/@earendil-works+pi-codemode@1.3.0/node_modules/@earendil-works/pi-codemode/dist/runtime/host.js';

describe('codemodeWorkerMismatch', () => {
  it('host 在 chunks/ 里且 chunks/worker.js 是入口时通过', () => {
    expect(codemodeWorkerMismatch([
      { fileName: 'chunks/execute-abc.js', isEntry: false, moduleIds: [host] },
      { fileName: 'chunks/worker.js', isEntry: true, moduleIds: [] },
    ])).toBeUndefined();
  });

  it('host 旁边没有 worker.js 入口时报错', () => {
    expect(codemodeWorkerMismatch([
      { fileName: 'chunks/execute-abc.js', isEntry: false, moduleIds: [host] },
      { fileName: 'pi-worker.js', isEntry: true, moduleIds: [] },
    ])).toContain('chunks/worker.js');
  });

  it('host 被并进根目录的入口时，要求根目录的 worker.js', () => {
    expect(codemodeWorkerMismatch([
      { fileName: 'agent-host.js', isEntry: true, moduleIds: [host.replace(/\//g, '\\')] },
      { fileName: 'chunks/worker.js', isEntry: true, moduleIds: [] },
    ])).toContain('worker.js');
  });

  it('没打包 codemode（开发态外置）时不检查', () => {
    expect(codemodeWorkerMismatch([{ fileName: 'main.js', isEntry: true, moduleIds: ['/repo/electron/main.ts'] }])).toBeUndefined();
  });
});
