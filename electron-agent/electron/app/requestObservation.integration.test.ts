import fs from 'node:fs';import net from 'node:net';import {syncBuiltinESMExports}from'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {ModelRuntime,SessionManager} from '../../../cli/src/pi-sdk.js';
import {observeModelRuntime} from '../../../cli/src/observed-model-runtime.js';
import {RequestObservations} from '../../../extensions/_shared/requestObservation.js';
const {createAgentSessionServices,createAgentSessionFromServices}=await import(new URL('./core/agent-session-services.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
const roots:string[]=[];afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();syncBuiltinESMExports();vi.useRealTimers();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
const frame=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
function response(status=200){return status===200?new Response(frame({id:'fixture-response',object:'chat.completion.chunk',created:1,model:'actual',choices:[{index:0,delta:{content:'SECRET_CONTENT'},finish_reason:null}]})+frame({id:'fixture-response',object:'chat.completion.chunk',created:1,model:'actual',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100000,completion_tokens:1,total_tokens:100001}})+'data: [DONE]\n\n',{status,headers:{'content-type':'text/event-stream','x-request-id':'safe-id','authorization':'SECRET_AUTH'}}):new Response('{"error":{"message":"fixture rate limit"}}',{status,headers:{'content-type':'application/json','retry-after':'0','x-request-id':'limited'}});}
async function fixture(api='openai-completions'){
 const root=await mkdtemp(join(tmpdir(),'request-observation-sdk-'));roots.push(root);
 vi.stubGlobal('fetch',()=>{throw new Error('NETWORK FORBIDDEN');});
 vi.spyOn(net.Socket.prototype,'connect').mockImplementation(()=>{throw new Error('NETWORK SOCKET FORBIDDEN');});
 const originalRead=fs.readFileSync;vi.spyOn(fs,'readFileSync').mockImplementation(((path:any,...args:any[])=>{const value=String(path);if(/(?:auth|credentials)\.json$/i.test(value)&&!value.startsWith(root))throw new Error('REAL CREDENTIAL READ FORBIDDEN');return (originalRead as any)(path,...args);}) as any);syncBuiltinESMExports();
 await writeFile(join(root,'models.json'),JSON.stringify({providers:{fixture:{api,baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-only',models:[{id:'alias',cost:{input:3,output:15,cacheRead:0.3,cacheWrite:3.75},promptCache:{short:11}}]}}}));
 const runtime=await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:join(root,'models.json'),modelsStorePath:join(root,'catalog.json'),allowModelNetwork:false,refreshOnCreate:false});
 const model=runtime.getModel('fixture','alias')!;const hub=new RequestObservations('sdk-generation');let statuses=[200];
 const transport=(async()=>response(statuses.shift()??200)) as typeof fetch;
 const injected=new Proxy(runtime,{get(t,k){const value=Reflect.get(t,k,t);if(k==='streamSimple'||k==='completeSimple')return (m:any,c:any,o:any)=>value.call(t,m,c,{...o,fetch:transport,transport:'sse',apiKey:api==='openai-codex-responses'?`header.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')}.signature`:'fixture-only',maxRetries:1});return typeof value==='function'?value.bind(t):value;}});
 return {root,runtime:injected,model,hub,setStatuses:(s:number[])=>{statuses=s;}};
}
it('real SDK OpenAI reports only successful callback after hidden retry, without leaking body or headers',async()=>{
 const f=await fixture();const observed=observeModelRuntime(f.runtime,{hub:f.hub,identity:()=>({sessionId:'session-a'})});let originals=0;
 f.setStatuses([429,200]);const msg=await observed.streamSimple(f.model,{messages:[{role:'user',content:'fixture',timestamp:1}]},{onResponse:()=>{originals++;}}).result();
 expect(msg.stopReason).toBe('stop');expect(originals).toBe(1);const state=f.hub.list()[0];expect(state.responses.map(r=>r.metadata.httpStatus)).toEqual([200]);expect(state.outcome?.responseModel).toBe('actual');expect(JSON.stringify(state)).not.toContain('SECRET');
});
it('ordinary AgentSession and completeSimple oneshot share safe contract but never identity',async()=>{
 const f=await fixture();const manager=SessionManager.inMemory(f.root);const observed=observeModelRuntime(f.runtime,{hub:f.hub,identity:()=>({sessionId:manager.getSessionId()})});
 const services=await createAgentSessionServices({cwd:f.root,agentDir:f.root,modelRuntime:observed,resourceLoaderOptions:{extensionFactories:[],noContextFiles:true,noExtensions:true,noSkills:true,noPromptTemplates:true}});
 const {session}=await createAgentSessionFromServices({services,sessionManager:manager,model:f.model,noTools:'all'});try{await session.prompt('fixture');await session.waitForIdle();}finally{session.dispose();}
 const oneshot=observeModelRuntime(f.runtime,{hub:f.hub,identity:()=>({sessionId:'oneshot',requestId:'diag-known'})});await oneshot.completeSimple(f.model,{messages:[{role:'user',content:'fixture',timestamp:1}]} );
 expect(f.hub.list()).toHaveLength(2);expect(f.hub.list()[1].identity).toMatchObject({sessionId:'oneshot',requestId:'diag-known'});expect(f.hub.list().every(s=>s.phase==='completed')).toBe(true);
});
it('real SDK CacheWarmer copied options receive a fresh request scope',async()=>{
 const f=await fixture();vi.useFakeTimers();const observed=observeModelRuntime(f.runtime,{hub:f.hub,identity:()=>({sessionId:'warm-session'})});
 const {CacheWarmer}=await import(new URL('./core/cache-warmer.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
 const manager=SessionManager.inMemory(f.root);manager.appendMessage({role:'assistant',provider:'fixture',api:'openai-completions',model:'alias',content:[],timestamp:1,stopReason:'stop',usage:{input:100000,output:1,cacheRead:0,cacheWrite:0,totalTokens:100001,cost:{input:0.3,output:0,cacheRead:0,cacheWrite:0,total:0.3}}});
 const warmer=new CacheWarmer(observed,manager,()=> 'idle');const opts={cacheRetention:'short'};warmer.start({model:f.model,context:{messages:[{role:'user',content:'fixture',timestamp:1}]},options:opts},()=>true);
 try{await vi.advanceTimersByTimeAsync(1000);expect(f.hub.list()).toHaveLength(1);expect(manager.getEntries().some((e:any)=>e.type==='usage'&&e.kind==='cache_warm')).toBe(true);}finally{warmer.cancel();}
});

it('real SDK Codex SSE reports rate-limit responses in observed response order',async()=>{
 const f=await fixture('openai-codex-responses');f.setStatuses([429,429]);
 const observed=observeModelRuntime(f.runtime,{hub:f.hub,identity:()=>({sessionId:'codex'})});
 const result=await observed.streamSimple(f.model,{messages:[{role:'user',content:'fixture',timestamp:1}]}).result();
 expect(result.stopReason).toBe('error');expect(f.hub.list()[0].responses.map(r=>r.metadata.httpStatus)).toEqual([429,429]);
});
it('real SDK adapter without public callbacks and pre-response failures remain unavailable',async()=>{
 const f=await fixture();const {fauxProvider,fauxAssistantMessage}=await import('@earendil-works/pi-ai');const faux=fauxProvider({provider:'silent',models:[{id:'silent'}]});
 const provider=new Proxy(faux.provider,{get(t,k){const fn=Reflect.get(t,k,t);if(k==='stream'||k==='streamSimple')return(m:any,c:any,o:any)=>fn.call(t,m,c,{...o,onResponse:undefined,onProviderStreamEvent:undefined});return typeof fn==='function'?fn.bind(t):fn;}});
 f.runtime.registerNativeProvider(provider);faux.setResponses([fauxAssistantMessage('unchanged')]);const observed=observeModelRuntime(f.runtime,{hub:f.hub,identity:()=>({sessionId:'unsupported'})});
 const msg=await observed.streamSimple(f.runtime.getModel('silent','silent')!,{messages:[]}).result();expect(msg.stopReason).toBe('stop');expect(f.hub.list()[0]).toMatchObject({availability:'unavailable',responses:[],phase:'completed'});
 await observed.streamSimple({...f.model,provider:'not-configured'},{messages:[]}).result();expect(f.hub.list()[1]).toMatchObject({availability:'unavailable',responses:[],phase:'failed'});
});
