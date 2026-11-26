import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { AgentHost } from '../agent/agentHost.js';
import type { WorkspaceHandle } from '../agent/workspaceHandle.js';
import { sessionOperationLeases, withSessionOperationLease } from './sessionOperationLease.js';

it('does not reload a transferring writer while unrelated handles can reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gren-transfer-reload-'));
  const sourcePath = join(root,'source.jsonl'); const otherPath = join(root,'other.jsonl');
  const sourceReload = vi.fn(async () => {}); const otherReload = vi.fn(async () => {});
  const make = (path:string,reload:()=>Promise<void>) => ({session:{sessionFile:path},reload,dispose:async()=>{}} as unknown as WorkspaceHandle);
  const handles = {source:make(sourcePath,sourceReload),other:make(otherPath,otherReload)};
  let requestReload: () => void = () => {};
  let sourceFinished!: () => void; let otherFinished!: () => void;
  const sourceDone = new Promise<void>(resolve => { sourceFinished = resolve; });
  const otherDone = new Promise<void>(resolve => { otherFinished = resolve; });
  const host = new AgentHost({
    createHandle:async workspace => handles[workspace as keyof typeof handles],
    watchConfig:() => () => {}, getConfig:() => undefined,
    onResourceReloadRequested:listener => { requestReload=listener; return () => {}; },
    withSessionOperation:async (handle,operation) => {
      try { await withSessionOperationLease(root,[handle.session.sessionFile!],operation); }
      finally { (handle===handles.source?sourceFinished:otherFinished)(); }
    },
  });
  const lease = await sessionOperationLeases(root).acquire([sourcePath]);
  try {
    await host.open('source','source'); await host.open('other','other'); requestReload();
    await Promise.all([sourceDone,otherDone]);
    expect(sourceReload).not.toHaveBeenCalled(); expect(otherReload).toHaveBeenCalledTimes(1);
    expect(host.get('source')).toBe(handles.source);
  } finally { await lease.release(); await host.closeAll(); await rm(root,{recursive:true,force:true}); }
});
