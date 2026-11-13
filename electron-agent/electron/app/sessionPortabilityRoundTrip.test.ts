import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {SessionManager,ModelRuntime,SettingsManager,createAgentSessionServices,createAgentSessionFromServices} from '../../../cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {createAssistantMessageEventStream} from '../../../cli/node_modules/@earendil-works/pi-ai/dist/index.js';
import compactionPolicy from '../../../extensions/compaction-policy/index.js';
import {__resetForTest} from '../../../extensions/_shared/runtime-config.js';
import {branchSnapshot,strictSessionJsonl,legacyExclusions} from './sessionWorkflowData.js';
const dirs:string[]=[];afterEach(async()=>{__resetForTest();vi.unstubAllEnvs();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const usage={input:3,output:2,cacheRead:1,cacheWrite:4,totalTokens:10,cost:{input:0.1,output:0.2,cacheRead:0.01,cacheWrite:0.02,total:0.33}};
async function capture(sm:SessionManager,dir:string){
 const modelsPath=join(dir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:'https://forbidden.invalid',apiKey:'fixture-only',models:[{id:'model',reasoning:false,input:['text','image']}]}}}));
 const modelRuntime=await ModelRuntime.create({modelsPath,authPath:join(dir,'auth.json'),allowModelNetwork:false});
 const services=await createAgentSessionServices({cwd:dir,agentDir:dir,modelRuntime,settingsManager:SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false}}),resourceLoaderOptions:{extensionFactories:[compactionPolicy],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}});
 const {session}=await createAgentSessionFromServices({services,sessionManager:sm,model:modelRuntime.getModel('fixture','model')!,tools:[]});await session.bindExtensions({mode:'rpc'});expect(session.extensionRunner.hasHandlers('context')).toBe(true);
 let sent:unknown;session.agent.streamFunction=((_model:unknown,context:unknown)=>{sent=structuredClone(context);const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message:{role:'assistant',api:'openai-completions',provider:'fixture',model:'model',content:[{type:'text',text:'stub'}],usage,stopReason:'stop',timestamp:999}});stream.end();});return stream;}) as never;
 try{expect(sent).toBeUndefined();await session.prompt('next explicit request');return sent;}finally{await session.abort();session.dispose();}
}
it.each(['add','remove'] as const)('real SDK exported branch cold request retains full-log legacy %s including collisions, no side body',async op=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-roundtrip-'));dirs.push(dir);vi.stubEnv('PI_RUNTIME_CONFIG',join(dir,'runtime.json'));await writeFile(join(dir,'runtime.json'),'{}');__resetForTest();
 const source=SessionManager.create(dir,join(dir,'sessions'));const m=source.appendMessage({role:'user',content:'M common ancestor',timestamp:1});source.appendMessage({role:'user',content:'collision same timestamp',timestamp:1});
 if(op==='remove')source.appendCustomEntry('context_exclusion',{op:'add',ts:1});
 const b=source.appendMessage({role:'user',content:'B retained',timestamp:2});source.branch(m);source.appendMessage({role:'user',content:'SECRET_A_SIDE',timestamp:3});source.appendCustomEntry('context_exclusion',{op,ts:1});source.branch(b);
 const snapshot=branchSnapshot(source);expect(JSON.stringify(snapshot)).not.toContain('SECRET_A_SIDE');expect(legacyExclusions(snapshot.entries).has(1)).toBe(op==='add');
 const exportFile=join(dir,'export.jsonl');const raw=[snapshot.header,...snapshot.entries].map(e=>JSON.stringify(e)).join('\n')+'\n';await writeFile(exportFile,raw);strictSessionJsonl(raw);
 const imported=SessionManager.open(exportFile);const sourceBytes=await readFile(source.getSessionFile()!,'utf8');
 const sourceRequest=await capture(source,dir);__resetForTest();const importedRequest=await capture(imported,dir);
 const semantic=(request:unknown)=>(request as {messages:Array<Record<string,unknown>>}).messages.map(({timestamp,...message})=>message);
 expect(semantic(sourceRequest)).toEqual(semantic(importedRequest));expect(imported.getEntry(m)).toEqual(source.getEntry(m));
 expect(JSON.stringify(importedRequest).includes('M common ancestor')).toBe(op==='remove');expect(JSON.stringify(importedRequest).includes('collision same timestamp')).toBe(op==='remove');
 expect((await readFile(source.getSessionFile()!,'utf8')).startsWith(sourceBytes)).toBe(true);
});
it('round-trip preserves native multimodal/signature/tool/summary/compaction/usage/response metadata and external fromId',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'metadata-roundtrip-'));dirs.push(dir);vi.stubEnv('PI_RUNTIME_CONFIG',join(dir,'runtime.json'));await writeFile(join(dir,'runtime.json'),'{}');__resetForTest();
 const sm=SessionManager.inMemory(dir);const image={type:'image' as const,mimeType:'image/png',data:'ZmFrZQ=='};
 const m=sm.appendMessage({role:'user',content:[{type:'text',text:'raw original'},image],timestamp:1});
 const a=sm.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'model',responseModel:'physical/model',content:[{type:'thinking',thinking:'thought',thinkingSignature:'signature'},{type:'text',text:'answer'},{type:'toolCall',id:'call',name:'read',arguments:{path:'file'}}],usage,stopReason:'toolUse',timestamp:2} as never);
 sm.appendMessage({role:'toolResult',toolCallId:'call',toolName:'read',content:[{type:'text',text:'tool result'},image],isError:false,timestamp:3});sm.appendUsage('cache_warm','fixture','model',usage);sm.appendCompaction('summary',m,100,{source:'fixture'},false,usage);const kept=sm.getLeafId()!;
 sm.branch(m);const side=sm.appendMessage({role:'user',content:'SIDE_SECRET',timestamp:4});sm.branchWithSummary(kept,'branch summary',{readFiles:['a']},false,usage);
 sm.appendContextEdit(m,{content:[{type:'text',text:'effective summary'},image]});sm.appendLabelChange(a,'assistant bookmark');sm.appendCustomEntry('session-preferences',{model:{provider:'fixture',id:'model'},thinkingLevel:'high',fastMode:false,approval:'readonly',mode:'ask',revision:3});
 const doc=branchSnapshot(sm);const raw=[doc.header,...doc.entries].map(e=>JSON.stringify(e)).join('\n');const checked=strictSessionJsonl(raw);const file=join(dir,'metadata-export.jsonl');await writeFile(file,[checked.header,...checked.entries].map(e=>JSON.stringify(e)).join('\n')+'\n');const imported=SessionManager.open(file);
 expect(raw).not.toContain('SIDE_SECRET');expect(imported.getLabel(a)).toBe('assistant bookmark');expect(imported.buildSessionProjection()).toMatchObject({messages:sm.buildSessionProjection().messages});expect(imported.getEntry(a)).toEqual(sm.getEntry(a));
 expect(imported.getBranch().find(e=>e.type==='branch_summary')).toMatchObject({fromId:side,usage});expect(imported.getBranch().find(e=>e.type==='compaction')).toMatchObject({firstKeptEntryId:m,usage});
 const sourceRequest=await capture(sm,dir);__resetForTest();const importedRequest=await capture(imported,dir);const semantic=(request:unknown)=>(request as {messages:Array<Record<string,unknown>>}).messages.map(({timestamp,...message})=>message);expect(semantic(importedRequest)).toEqual(semantic(sourceRequest));
});
