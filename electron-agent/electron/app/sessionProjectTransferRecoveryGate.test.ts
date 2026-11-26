import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { PiRuntimeService } from './piRuntimeService.js';
import { SessionProjectTransferJournal, sha256Text } from './sessionProjectTransferJournal.js';
import { sessionOperationLeases } from './sessionOperationLease.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function fixture(open: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(),'gren-transfer-recovery-gate-')); roots.push(root);
  const agentDir = join(root,'agent'); const source = join(root,'source'); const target = join(root,'target');
  const path = join(agentDir,'sessions','main.jsonl');
  await Promise.all([mkdir(join(agentDir,'sessions'),{recursive:true}),mkdir(source),mkdir(target)]);
  const runtimeConfigPath = join(root,'runtime.json'); await writeFile(runtimeConfigPath,'{}');
  const content = (cwd:string) => `${JSON.stringify({type:'session',version:3,id:'main',cwd,timestamp:'2026-11-17T00:00:00.000Z'})}\n`;
  await writeFile(path,content(source));
  const before = {path,content:content(source),sha256:sha256Text(content(source)),bytes:Buffer.byteLength(content(source))};
  const after = {path,content:content(target),sha256:sha256Text(content(target)),bytes:Buffer.byteLength(content(target)),beforeSha256:before.sha256};
  const operationId = '44444444-4444-4444-8444-444444444444';
  const journal = new SessionProjectTransferJournal(agentDir);
  await journal.savePrepared({operationId,sourceWorkspace:source,targetWorkspace:target,sessionId:'main',sessionPath:path,leafId:null,
    revision:'r',fingerprint:'f',family:[],registryHash:sha256Text('[]'),registryRecordCount:0,before:[before],after:[after],
    registry:{version:1,rows:[],expectedSourceHash:sha256Text('[]'),expectedTargetHash:sha256Text('[]')},now:1});
  const service = new PiRuntimeService({agentDir,runtimeConfigPath,
    agentHost:{get:()=>undefined,workspaces:()=>[]} as never,modelRuntimeHost:{} as never,hasLiveJobs:()=>false,
    sessionTransferPorts:{registry:{read:async()=>[],apply:async()=>{},rollback:async()=>{}},writers:{open}},
  });
  const commit = async () => {
    await writeFile(path,after.content);
    const loaded=await journal.load(operationId); await journal.transition(loaded!.manifest!,'committed');
  };
  const background = () => (service as unknown as {backgroundTransferRecovery:Map<string,Promise<void>>}).backgroundTransferRecovery.get(operationId);
  return {agentDir,path,service,journal,operationId,commit,background};
}
it('retries uncommitted cold recovery after a previously held lease is released', async () => {
  const f = await fixture(async()=>{});
  const lease = await sessionOperationLeases(f.agentDir).acquire([f.path],{allowBlocked:true});
  try {
    await f.service.recoverSessionTransfers();
    expect((await f.journal.load(f.operationId))!.manifest!.state).toBe('prepared');
  } finally { await lease.release(); }
  await f.service.recoverSessionTransfers();
  expect((await f.journal.load(f.operationId))!.manifest!.state).toBe('rolled-back');
});
it('keeps a slow committed target open out of unrelated command paths', async () => {
  let entered!:()=>void; let finish!:()=>void;
  const enteredOpen = new Promise<void>(resolve=>{entered=resolve;}); const releaseOpen = new Promise<void>(resolve=>{finish=resolve;});
  const f = await fixture(async()=>{entered();await releaseOpen;}); await f.commit();
  await f.service.recoverSessionTransfers(); await enteredOpen;
  try {
    await f.service.recoverSessionTransfers();
    await expect(f.service.send('unrelated-project','agent_get_session_defaults',{})).resolves.toBeDefined();
    expect((await f.journal.load(f.operationId))!.manifest!.state).toBe('committed');
  } finally { const pending=f.background();finish();await pending; }
  expect((await f.journal.load(f.operationId))!.manifest!.state).toBe('opened');
});
it('does not repeat a known failed target open on every ordinary request', async () => {
  const open=vi.fn(async()=>{throw new Error('target startup failed');}); const f=await fixture(open);await f.commit();
  await f.service.recoverSessionTransfers();await f.background();
  expect(open).toHaveBeenCalledTimes(1);
  await f.service.recoverSessionTransfers();await f.service.recoverSessionTransfers();
  expect(open).toHaveBeenCalledTimes(1);
  expect((await f.journal.load(f.operationId))!.manifest!.state).toBe('committed');
});
