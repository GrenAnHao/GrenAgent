import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import { SessionWorkflowOwner } from './sessionWorkflowOwner.js';
import { branchSnapshot, legacyExclusions, strictSessionJsonl } from './sessionWorkflowData.js';
const cliRequire=createRequire(new URL('../../../cli/package.json',import.meta.url));
const sdkPath=realpathSync(fileURLToPath(new URL('../../../cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js',import.meta.url)));
const sdk=await import(pathToFileURL(sdkPath).href) as typeof import('../../../cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const sdkRequire=createRequire(sdkPath);
const aiRoot=sdkRequire.resolve.paths('@earendil-works/pi-ai')!.map(p=>join(p,'@earendil-works/pi-ai')).find(p=>existsSync(join(p,'package.json')))!;
const ai=await import(pathToFileURL(join(aiRoot,'dist/index.js')).href);
const dirs:string[]=[];afterEach(async()=>{vi.unstubAllGlobals();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'workflow-sdk-'));dirs.push(dir);
 await writeFile(join(dir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:'https://no-network.invalid',apiKey:'fixture-only',models:[{id:'local-stub',reasoning:false,input:['text']}]}}}));
 const modelRuntime=await sdk.ModelRuntime.create({modelsPath:join(dir,'models.json'),authPath:join(dir,'auth.json'),allowModelNetwork:false});
 const settingsManager=sdk.SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false}} as never);
 const services=await sdk.createAgentSessionServices({cwd:dir,agentDir:dir,modelRuntime,settingsManager,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}});
 const sm=sdk.SessionManager.create(dir,join(dir,'sessions'));
 const m=sm.appendMessage({role:'user',content:'M ancestor',timestamp:1});
 const a=sm.appendMessage({role:'assistant',content:[{type:'text',text:'assistant original'}],api:'openai-completions',provider:'fixture',model:'local-stub',usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:2});
 const {session}=await sdk.createAgentSessionFromServices({services,sessionManager:sm,model:modelRuntime.getModel('fixture','local-stub')!,tools:[]});
 await session.bindExtensions({mode:'rpc'});
 const sent:unknown[]=[];
 session.agent.streamFunction=((model:unknown,context:unknown)=>{sent.push(structuredClone(context));const stream=ai.createAssistantMessageEventStream();const message={role:'assistant',content:[{type:'text',text:'stub result'}],api:'openai-completions',provider:'fixture',model:'local-stub',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:10};queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}) as never;
 return{dir,sm,m,a,session,sent};
}
it('uses cli coding-agent 1.5.1 actual SDK and dependency root with zero network before explicit prompt',async()=>{
 const pkg=JSON.parse(await readFile(join(sdkPath,'../../package.json'),'utf8'));expect(pkg.version).toBe('1.5.1');
 let network=0;vi.stubGlobal('fetch',()=>{network++;throw Error('network forbidden');});
 const f=await fixture();try{
 const owner=new SessionWorkflowOwner(f.dir);const raw=f.sm.getEntry(f.a);await owner.execute(f.session,{action:'edit',...owner.tree(f.session),entryId:f.a,text:'summary'});
 expect(f.session.messages.some(m=>'content' in m&&JSON.stringify(m.content).includes('summary'))).toBe(true);expect(f.sm.getEntry(f.a)).toEqual(raw);
 const snapshot=branchSnapshot(f.sm);strictSessionJsonl([snapshot.header,...snapshot.entries].map(e=>JSON.stringify(e)).join('\n'));
 await owner.execute(f.session,{action:'navigate',...owner.tree(f.session),entryId:f.m,draftChoice:'keep'});expect(f.sm.getLeafId()).toBeNull();expect(f.sent).toHaveLength(0);expect(network).toBe(0);
 await f.session.prompt('explicit new request');expect(f.sent.length).toBeGreaterThan(0);expect(network).toBe(0);
 }finally{await f.session.abort();f.session.dispose();}
});


it('real SDK branch summary uses only abandoned path and keeps native usage/fromId',async()=>{
 const f=await fixture();try{
  f.sm.branch(f.m);const b=f.sm.appendMessage({role:'user',content:'B abandoned only',timestamp:3});f.session.refreshContext();
  const result=await f.session.navigateTree(f.a,{summarize:true});
  expect(result.cancelled).toBe(false);expect(result.summaryEntry?.type).toBe('branch_summary');expect(result.summaryEntry?.fromId).toBe(b);expect(result.summaryEntry?.usage?.input).toBe(1);
  expect(f.sent).toHaveLength(1);expect(JSON.stringify(f.sent[0])).toContain('B abandoned only');expect(JSON.stringify(f.sent[0])).not.toContain('M ancestor');
 }finally{await f.session.abort();f.session.dispose();}
});
it('cancelling real SDK summary preserves its original leaf without silently navigating',async()=>{
 const f=await fixture();try{f.sm.branch(f.m);const old=f.sm.appendMessage({role:'user',content:'abandoned',timestamp:3});f.session.refreshContext();
 const pending=f.session.navigateTree(f.a,{summarize:true});f.session.abortBranchSummary();await expect(pending).rejects.toMatchObject({name:'AbortError'});
 expect(f.sm.getLeafId()).toBe(old);expect(f.sm.getEntries().filter(e=>e.type==='branch_summary')).toHaveLength(0);
 }finally{await f.session.abort();f.session.dispose();}
});

