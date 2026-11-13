import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {zstdDecompressSync} from 'node:zlib';
import {afterEach,expect,it} from 'vitest';
import {ModelRuntime} from '../../../cli/src/pi-sdk';
import {getPromptCacheTtlMs} from '@earendil-works/pi-ai';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){
 const {loadState,serializeState}=await import(new URL('../../src/features/settings/providerConfigAdapter.ts',import.meta.url).href);
 const root=await mkdtemp(join(tmpdir(),'gren-model-advanced-'));roots.push(root);
 const source=serializeState([{id:'advanced-fixture',name:'Fixture',builtIn:false,api:'openai-completions',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-key',models:[{id:'org/model',reasoning:true,input:['text','image'],contextWindow:32000,maxTokens:1024,thinkingLevelMap:{low:'low',high:'high'},samplingParams:{top_p:0.2,flag:false},samplingParamsByThinkingLevel:{low:{top_k:3},high:{top_k:9}},inputLimits:{images:{maxPerRequest:1,resize:{maxWidth:8,maxHeight:8,maxBytes:100000,jpegQuality:80}},maxRequestBytes:100000},promptCache:{short:0.5}}]}]);
 await writeFile(join(root,'models.json'),serializeState(loadState(source.modelsJson,'{}',[])).modelsJson);
 const runtime=await ModelRuntime.create({modelsPath:join(root,'models.json'),authPath:join(root,'auth.json'),modelsStorePath:join(root,'model-cache.json'),allowModelNetwork:false});expect(runtime.getError()).toBeUndefined();const model=runtime.getModel('advanced-fixture','org/model')!;expect(model).toBeDefined();return{runtime,model,root};
}
it('UI metadata reaches the actual SDK request with base → thinking-level → caller sampling priority and known/unknown TTL',async()=>{
 const {runtime,model}=await fixture();expect(model.inputLimits).toEqual({images:{maxPerRequest:1,resize:{maxWidth:8,maxHeight:8,maxBytes:100000,jpegQuality:80}},maxRequestBytes:100000});expect(model.promptCache).toEqual({short:0.5});
 expect(getPromptCacheTtlMs(model as never,{cacheRetention:'short'})).toBe(500);expect(getPromptCacheTtlMs(model as never,{cacheRetention:'long'})).toBeUndefined();
 for(const [level,top_k]of [['low',3],['high',9]] as const){const requests:any[]=[];
  await runtime.streamSimple(model,{messages:[{role:'user',content:'fixture',timestamp:1}]},{apiKey:'fixture-key',reasoning:level,samplingParams:{top_p:0.8},maxRetries:0,fetch:(async(_url,init)=>{const bytes=Buffer.from(await new Response(init?.body).arrayBuffer());const text=new Headers(init?.headers).get('content-encoding')==='zstd'?zstdDecompressSync(bytes).toString():bytes.toString();requests.push(JSON.parse(text));return new Response(JSON.stringify({error:{message:'fixture-stop'}}),{status:400,headers:{'content-type':'application/json'}});}) as typeof fetch}).result();
  expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({top_p:0.8,top_k,flag:false});
 }
});
it('SDK 1.5.1 retains count metadata but does not enforce it at transport; SDK resize uses the same model profile',async()=>{
 const {runtime,model}=await fixture();const images=[{type:'image',mimeType:'image/png',data:'aA=='},{type:'image',mimeType:'image/png',data:'aA=='}];let requests=0;
 const result=await runtime.streamSimple(model,{messages:[{role:'user',content:images as never,timestamp:1}]},{apiKey:'fixture-key',maxRetries:0,fetch:(async()=>{requests++;throw new Error('transport must not execute');}) as typeof fetch}).result();
 expect(requests).toBe(1);expect(result.stopReason).toBe('error');expect(images).toHaveLength(2);
 const sharp=(await import('sharp')).default;const {resizeImage}=await import('@earendil-works/pi-coding-agent');
 const png=await sharp({create:{width:64,height:32,channels:3,background:{r:100,g:20,b:40}}}).png().toBuffer();
 const resized=await resizeImage(png,'image/png',model.inputLimits!.images!.resize);
 expect(resized!.width).toBeLessThanOrEqual(8);expect(resized!.height).toBeLessThanOrEqual(8);expect(png).toEqual(await sharp({create:{width:64,height:32,channels:3,background:{r:100,g:20,b:40}}}).png().toBuffer());
});

it('high-level AgentSession also currently forwards two images and oversized body despite count/byte metadata',async()=>{
 const {runtime,model,root}=await fixture();
 const {createAgentSessionServices,createAgentSessionFromServices,SessionManager}=await import('@earendil-works/pi-coding-agent');
 const sharp=(await import('sharp')).default;const png=await sharp({create:{width:32,height:32,channels:3,background:{r:1,g:2,b:3}}}).png().toBuffer();
 const limited={...model,inputLimits:{...model.inputLimits,maxRequestBytes:100,images:{...model.inputLimits?.images,maxPerMessage:1,maxPerRequest:1}}};
 await writeFile(join(root,'settings.json'),JSON.stringify({retry:{enabled:false},cacheWarming:'off',compaction:{enabled:false}}));
 const services=await createAgentSessionServices({cwd:root,agentDir:root,modelRuntime:runtime as never,resourceLoaderOptions:{extensionFactories:[],noContextFiles:true}});
 const {session}=await createAgentSessionFromServices({services,sessionManager:SessionManager.inMemory(root),model:limited as never});
 let requests=0;let bodyBytes=0;
 session.agent.streamFunction=(requestModel,context,options)=>runtime.streamSimple(requestModel as never,context as never,{...options,maxRetries:0,fetch:(async(_url,init)=>{requests++;bodyBytes=Buffer.byteLength(await new Response(init?.body).text());return new Response(JSON.stringify({error:{message:'fixture-stop'}}),{status:400,headers:{'content-type':'application/json'}});}) as typeof fetch}) as never;
 try{await session.prompt('fixture',{images:[{type:'image',data:png.toString('base64'),mimeType:'image/png'},{type:'image',data:png.toString('base64'),mimeType:'image/png'}]});
 await writeFile(new URL('../../../.agents/evidence/2026-11-10-complete-desktop-model-settings/image-session-messages.json',import.meta.url),JSON.stringify(session.messages,null,2));
 expect(requests).toBe(1);expect(bodyBytes).toBeGreaterThan(100);
 await writeFile(new URL('../../../.agents/evidence/2026-11-10-complete-desktop-model-settings/image-preflight-boundary.json',import.meta.url),JSON.stringify({requests,bodyBytes,limits:limited.inputLimits,layer:'AgentSession.prompt → actual provider serializer → injected fetch (local 400)'},null,2));
 }finally{session.dispose();}
});


it('actual Gren factory prompt consumes the guard once, refuses explicit image quotas and preserves attachments',async()=>{
 const {runtime,model,root}=await fixture();const{makeGrenRuntimeFactory}=await import('../../../cli/src/gren-runtime');const{createAgentSessionServices,createAgentSessionFromServices,SessionManager}=await import('@earendil-works/pi-coding-agent');
 await writeFile(join(root,'settings.json'),JSON.stringify({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}));
 const created=await makeGrenRuntimeFactory({modelRuntime:runtime,extraFactories:[],deps:{createAgentSessionServices,createAgentSessionFromServices,manifestExtensions:[],getConfig:()=>undefined,prepareObservation:(value:any)=>value,trackUsage:()=>{}}as never})({cwd:root,agentDir:root,sessionManager:SessionManager.inMemory(root)as never});const session=created.session;await session.setModel(model as never);
 let requests=0;const guardedRuntime=created.services.modelRuntime;
 session.agent.streamFunction=(m,c,o)=>guardedRuntime.streamSimple(m,c,{...o,maxRetries:0,fetch:(async()=>{requests++;throw new Error('transport must not run');})as typeof fetch});
 const sharp=(await import('sharp')).default;const bytes=await sharp({create:{width:16,height:16,channels:3,background:{r:1,g:2,b:3}}}).png().toBuffer();const images=[{type:'image' as const,data:bytes.toString('base64'),mimeType:'image/png'},{type:'image' as const,data:bytes.toString('base64'),mimeType:'image/png'}];
 try{await session.prompt('fixture',{images});expect(requests).toBe(0);expect((session.messages.at(-1)as any).errorMessage).toContain('图片输入限制');expect(images).toHaveLength(2);expect(session.messages.find(message=>message.role==='user')).toBeDefined();}finally{session.dispose();}
},15000);
