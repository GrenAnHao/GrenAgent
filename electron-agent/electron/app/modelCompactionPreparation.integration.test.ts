import{mkdtemp,readFile,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{afterEach,expect,it,vi}from'vitest';
import{ModelRuntime,SessionManager}from'../../../cli/src/pi-sdk';
import{createAgentSessionServices,createAgentSessionFromServices}from'@earendil-works/pi-coding-agent';
import{createAssistantMessageEventStream}from'@earendil-works/pi-ai';
import{attachModelCompactionControl,syncSessionModelCompactionBudget}from'../../../cli/src/model-compaction-control';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
it('actual SDK manual/automatic preparation captures old budgets while compaction runs; later checks use new values without changing enabled/percent/cancel behavior',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gren-compaction-prep-'));roots.push(root);
 const sdkSettings={cacheWarming:'off',retry:{enabled:false},compaction:{enabled:true,reserveTokens:1000,keepRecentTokens:2000}};
 await writeFile(join(root,'settings.json'),JSON.stringify(sdkSettings));await writeFile(join(root,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-key',models:[{id:'A',contextWindow:100000,maxTokens:1024}]}}}));
 const runtime=await ModelRuntime.create({modelsPath:join(root,'models.json'),authPath:join(root,'auth.json'),modelsStorePath:join(root,'model-cache.json'),allowModelNetwork:false});
 const sm=SessionManager.inMemory(root);for(let i=0;i<30;i++){sm.appendMessage({role:'user',content:'fixture '.repeat(100),timestamp:i*2} as never);sm.appendMessage({role:'assistant',content:[{type:'text',text:'fixture '.repeat(100)}],api:'openai-completions',provider:'fixture',model:'A',stopReason:'stop',usage:{input:10000,output:20,cacheRead:0,cacheWrite:0,totalTokens:10020,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:i*2+1} as never);}
 const captured:Array<{reason:string;settings:any}>=[];let release=()=>{};const pause=new Promise<void>(resolve=>{release=resolve;});
 const services=await createAgentSessionServices({cwd:root,agentDir:root,modelRuntime:runtime as never,resourceLoaderOptions:{noContextFiles:true,extensionFactories:[pi=>{pi.on('session_before_compact',async event=>{captured.push({reason:event.reason,settings:event.preparation.settings});if(captured.length===1)await pause;return{cancel:true};});}]}});
 const{session}=await createAgentSessionFromServices({services,sessionManager:sm as never,model:runtime.getModel('fixture','A') as never});await session.bindExtensions({mode:'rpc'});
 let budgets={'fixture/A':{reserveTokens:95000,keepRecentTokens:50}};attachModelCompactionControl(session as never,root,root,{read:()=>budgets,watch:()=>()=>{}});
 session.agent.streamFunction=(model)=>{const stream=createAssistantMessageEventStream();queueMicrotask(()=>stream.push({type:'done',reason:'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'local fixture'}],stopReason:'stop',timestamp:1,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}}));return stream;};
 try{
  const pending=session.compact().catch(error=>error);await vi.waitFor(()=>expect(captured).toHaveLength(1));
  budgets={'fixture/A':{reserveTokens:99000,keepRecentTokens:75}};await syncSessionModelCompactionBudget(session as never);
  expect(captured[0].settings).toMatchObject({reserveTokens:95000,keepRecentTokens:50});release();expect((await pending).message).toMatch(/cancel/i);
  await expect(session.compact()).rejects.toThrow(/cancel/i);expect(captured[1].settings).toMatchObject({reserveTokens:99000,keepRecentTokens:75});
  await session.prompt('fixture');expect(captured.some(event=>event.reason==='threshold'&&event.settings.keepRecentTokens===75)).toBe(true);
  expect(session.settingsManager.getCompactionEnabled()).toBe(true);expect(JSON.parse(await readFile(join(root,'settings.json'),'utf8'))).toEqual(sdkSettings);
 }finally{release();session.dispose();}
},15000);

