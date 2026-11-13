import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import type { UsageOriginRegistry } from '../../../extensions/usage-ledger/originRegistry.js';
import { SESSION_PREFERENCES_ENTRY, type SessionPreferences } from '../../../extensions/_shared/session-preferences.js';
import { branchSnapshot, strictSessionJsonl, type SessionDocument } from './sessionWorkflowData.js';
export interface CandidateInput {
  source?:SessionManager; document?:SessionDocument; leafId?:string|null;
  kind:'fork'|'clone'|'import'; directory:string; cwd:string;
  registry:Pick<UsageOriginRegistry,'prepare'|'commit'|'abort'>;
  preferences:SessionPreferences; pulseRev?:number;
}
export interface SessionCandidate {
  operationId:string;sessionId:string;stagingPath:string;finalPath:string;
  publish():Promise<void>;selected():Promise<void>;abort():Promise<void>;
}
/** No source handle is touched here. The caller must validate a candidate runtime before publish/focus. */
export async function prepareSessionCandidate(input:CandidateInput):Promise<SessionCandidate>{
  const operationId=randomUUID(),sessionId=randomUUID();
  const doc=input.document??(input.source?branchSnapshot(input.source,input.leafId):undefined);
  if(!doc)throw new Error('Candidate requires a source snapshot');
  const stagingDir=join(input.directory,'.workflow-staging');await mkdir(stagingDir,{recursive:true});
  const stagingPath=join(stagingDir,`${operationId}.jsonl`),finalPath=join(input.directory,`${new Date().toISOString().replace(/[:.]/g,'-')}_${sessionId}.jsonl`),manifestPath=join(stagingDir,`${operationId}.json`);
  const header={...doc.header,id:sessionId,cwd:input.cwd,timestamp:new Date().toISOString(),parentSession:input.source?.getSessionFile()};
  const entries=structuredClone(doc.entries);let parentId=entries.at(-1)?.id??null;
  const append=(customType:string,data:unknown)=>{const e={type:'custom' as const,id:randomUUID(),parentId,timestamp:new Date().toISOString(),customType,data};entries.push(e);parentId=e.id;};
  append('context_exclusion_snapshot',{version:1,pulseRev:input.pulseRev ?? 0});
  append('working_directory',{cwd:input.cwd,confirmedLocal:true});
  append(SESSION_PREFERENCES_ENTRY,input.preferences);
  append('usage_origin_required',{version:1,operationId});
  const raw=[header,...entries].map(e=>JSON.stringify(e)).join('\n')+'\n';strictSessionJsonl(raw);
  const manifest={version:1,operationId,sessionId,stagingPath,finalPath,source:input.source?.getSessionFile(),state:'prepared'};
  const save=async(state:string)=>{manifest.state=state;await writeFile(manifestPath,JSON.stringify(manifest),'utf8');};
  let prepared=false,published=false;
  try{
    await writeFile(stagingPath,raw,{encoding:'utf8',flag:'wx'});
    const historicalIds=new Set(doc.entries.map(e=>e.id));
    const mappings=entries.filter(e=>input.kind==='import'?historicalIds.has(e.id):e.type==='message'&&e.message.role==='assistant'||e.type==='usage'&&e.kind==='cache_warm').map(e=>({targetEntryId:e.id,...(input.kind!=='import'&&input.source?{source:{sessionId:input.source.getSessionId(),entryId:e.id}}:{})}));
    input.registry.prepare({operationId,kind:input.kind,targetSessionId:sessionId,mappings});prepared=true;await save('prepared');
  }catch(e){if(prepared)input.registry.abort(operationId);await rm(stagingPath,{force:true});await rm(manifestPath,{force:true});throw e;}
  return{operationId,sessionId,stagingPath,finalPath,
    async publish(){
      // Re-read marker at the barrier: a failed/missing append can never publish an unmarked new identity.
      const verified=strictSessionJsonl(await readFile(stagingPath,'utf8'));
      if(verified.header.id!==sessionId||!verified.entries.some(e=>e.type==='custom'&&e.customType==='usage_origin_required'&&(e.data as {operationId?:string})?.operationId===operationId))throw new Error('Candidate origin marker missing');
      input.registry.commit(operationId);await save('origins-committed');await rename(stagingPath,finalPath);published=true;await save('published');
    },
    async selected(){if(!published)throw new Error('Candidate not published');await save('selected');},
    async abort(){input.registry.abort(operationId);if(!published)await rm(stagingPath,{force:true});await save(published?'published-not-selected':'aborted');},
  };
}


export async function candidateSelectionState(manager:SessionManager):Promise<{path:string;manifest:Record<string,unknown>}|undefined>{
  const marker=[...manager.getEntries()].reverse().find(e=>e.type==='custom'&&e.customType==='usage_origin_required');
  const operationId=(marker?.type==='custom'?marker.data:undefined) as {operationId?:unknown}|undefined;
  if(typeof operationId?.operationId!=='string'||!/^[0-9a-f-]{36}$/i.test(operationId.operationId)||!manager.getSessionFile())return;
  const file=manager.getSessionFile()!;const directory=dirname(file);
  const path=join(basename(directory)==='.workflow-staging'?directory:join(directory,'.workflow-staging'),`${operationId.operationId}.json`);
  let manifest:Record<string,unknown>;try{manifest=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  if(manifest.sessionId!==manager.getSessionId()||manifest.operationId!==operationId.operationId||![manifest.finalPath,manifest.stagingPath].some(p=>typeof p==='string'&&resolve(p)===resolve(file)))return;
  return{path,manifest};
}
export async function confirmCandidateRecovery(manager:SessionManager,confirm=true):Promise<void>{
  const state=await candidateSelectionState(manager);if(!state)return;
  if(state.manifest.state==='prepared'||state.manifest.state==='origins-committed'||state.manifest.state==='aborted')throw new Error('CANDIDATE_NOT_PUBLISHED');
  if(confirm&&state.manifest.state!=='selected')await writeFile(state.path,JSON.stringify({...state.manifest,state:'selected'}),'utf8');
}


