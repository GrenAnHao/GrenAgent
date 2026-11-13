import{mkdtemp,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{afterEach,expect,it,vi}from'vitest';
import{ModelRuntime}from'../../../cli/src/pi-sdk';import{guardModelInputLimits}from'../../../cli/src/model-input-limits';import{assertModelInputLimits}from'../../../extensions/_shared/model-input-limit-policy';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(api='openai-completions',inputLimits:any={images:{maxPerMessage:1,maxPerRequest:1}}){const root=await mkdtemp(join(tmpdir(),'gren-input-limit-'));roots.push(root);await writeFile(join(root,'models.json'),JSON.stringify({providers:{fixture:{api,baseUrl:'http://127.0.0.1:1/v1',models:[{id:'A',input:['text','image'],inputLimits}]}}}));const real=await ModelRuntime.create({modelsPath:join(root,'models.json'),authPath:join(root,'auth.json'),modelsStorePath:join(root,'cache.json'),allowModelNetwork:false});expect(real.getError()).toBeUndefined();return{real,root,runtime:guardModelInputLimits(real,{modelsPath:join(root,'models.json')}),model:real.getModel('fixture','A')!};}
const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6GxQAAAAASUVORK5CYII='};
for(const api of ['openai-completions','openai-responses','anthropic-messages','google-generative-ai','google-vertex','azure-openai-responses','openai-codex-responses'])it(`${api} real serializer refuses excess images before transport`,async()=>{
 const{runtime,model}=await fixture(api);let fetches=0;let callbacks=0;
 const stopFetch=(async()=>{fetches++;throw new Error('transport must not run');}) as typeof fetch;const google=api.startsWith('google-');if(google)vi.stubGlobal('fetch',stopFetch);
 const jwt=`e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')}.fixture`;
 let result;try{result=await runtime.streamSimple(model,{messages:[{role:'user',content:[image,image] as never,timestamp:1}]},{apiKey:api==='openai-codex-responses'?jwt:'fixture-key',transport:'sse',maxRetries:0,onPayload:()=>{callbacks++;},fetch:stopFetch}).result();}finally{if(google)vi.unstubAllGlobals();}
 if(!callbacks)await writeFile(new URL(`../../../.agents/evidence/2026-11-10-complete-desktop-model-settings/input-${api}.json`,import.meta.url),JSON.stringify(result,null,2));
 expect(callbacks).toBe(1);expect(fetches).toBe(0);expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain('图片输入限制');
});
it('checks replacement payload after the original callback exactly once, without counting omitted continuation history',async()=>{
 const{runtime,model}=await fixture('openai-responses');expect(guardModelInputLimits(runtime)).toBe(runtime);let callbacks=0,fetches=0;
 const result=await runtime.completeSimple(model,{messages:[{role:'user',content:[image,image] as never,timestamp:1}]},{apiKey:'fixture-key',maxRetries:0,onPayload:payload=>{callbacks++;return{...(payload as any),previous_response_id:'fixture-server-state',input:[{role:'user',content:[{type:'input_text',text:'new message'}]}]};},fetch:(async()=>{fetches++;return new Response(JSON.stringify({error:{message:'fixture-stop'}}),{status:400,headers:{'content-type':'application/json'}});})as typeof fetch});
 expect(callbacks).toBe(1);expect(fetches).toBe(1);expect(result.errorMessage).not.toContain('图片输入限制');
});
it('counts UTF-8 bytes on final uncompressed JSON and preserves thrown callbacks',async()=>{
 const{runtime,model}=await fixture('openai-completions',{maxRequestBytes:2});let fetches=0;let callbacks=0;
 const run=(onPayload:any)=>runtime.completeSimple(model,{messages:[{role:'user',content:'fixture',timestamp:1}]},{apiKey:'fixture-key',maxRetries:0,onPayload,fetch:(async()=>{fetches++;throw new Error('transport must not run');})as typeof fetch});
 const result=await run(()=>{callbacks++;return{字:'文'};});expect(result.errorMessage).toContain('UTF-8 未压缩 JSON 为 13 bytes');expect(callbacks).toBe(1);expect(fetches).toBe(0);
 const thrown=await run(()=>{throw new Error('original callback failure');});expect(thrown.errorMessage).toContain('original callback failure');expect(fetches).toBe(0);
});
it('unsupported APIs remain explicitly unguarded and current payload counts, not context history, determine limits',()=>{
 expect(()=>assertModelInputLimits({messages:[{content:[{type:'image'},{type:'image'}]}]},{api:'unknown-api',inputLimits:{images:{maxPerRequest:1}}})).not.toThrow();
 expect(()=>assertModelInputLimits({messages:[{content:[{type:'tool_result',content:[{type:'image'},{type:'image'}]}]}]},{api:'anthropic-messages',inputLimits:{images:{maxPerMessage:1}}})).toThrow('单条消息');
});

it('unsupported Google bytes and automatic Codex WebSocket constraints reject before any transport; legacy unconstrained calls keep their options',async()=>{
 for(const api of ['google-generative-ai','openai-codex-responses','mistral-conversations']){
  const {runtime,model}=await fixture(api,api.startsWith('google')?{maxRequestBytes:100}:{images:{maxPerRequest:1}});let callbacks=0,fetches=0;
  expect(()=>runtime.streamSimple(model,{messages:[]},{apiKey:'fixture-key',onPayload:()=>{callbacks++;},fetch:(async()=>{fetches++;throw new Error('must not run');})as typeof fetch})).toThrow('输入限制暂不支持');expect(fetches).toBe(0);expect(callbacks).toBe(0);
 }
 const opts={signal:new AbortController().signal,onPayload:()=>undefined};let calls=0;const legacy={streamSimple(model:any,context:any,options:any){calls++;expect(options).toBe(opts);return{model,context};}};
 const wrapped=guardModelInputLimits(legacy);wrapped.streamSimple({api:'unknown-api'},{messages:[]},opts);expect(calls).toBe(1);
});
it('all four public request methods preserve their original method contract and invoke the real method once',async()=>{
 const{runtime,model}=await fixture();const context={messages:[{role:'user',content:[image,image]as never,timestamp:1}]};
 for(const method of ['stream','streamSimple','complete','completeSimple']as const){let calls=0;const result=(runtime[method]as any)(model,context,{apiKey:'fixture-key',maxRetries:0,onPayload:()=>{calls++;},fetch:async()=>{throw new Error('must not run');}});const message=await(typeof result.result==='function'?result.result():result);expect(message.errorMessage).toContain('图片输入限制');expect(calls).toBe(1);}
});

it('shared oneshot enforces serialized byte budgets without changing the original usage/error contract',async()=>{
 const {runOneshotWithRuntime}=await import('../../../extensions/_shared/oneshot');
 const{real,root}=await fixture('openai-completions',{maxRequestBytes:2});let requests=0;const stop=(async()=>{requests++;throw new Error('transport must not run');})as typeof fetch;vi.stubGlobal('fetch',stop);
 const complete=real.completeSimple.bind(real);real.completeSimple=(model,context,options)=>complete(model,context,{apiKey:'fixture-key',maxRetries:0,...options,fetch:options?.fetch??stop});
 try{const lines:any[]=[];await runOneshotWithRuntime(real as never,{provider:'fixture',modelId:'A',user:'fixture'},line=>lines.push(line),{modelsPath:join(root,'models.json')});expect(requests).toBe(0);expect(lines[0]).toMatchObject({ok:false,error:expect.stringContaining('请求输入限制')});}finally{vi.unstubAllGlobals();}
});

it('audits native SDK quota metadata without credentials or network',async()=>{
 const{real}=await fixture();const rows=real.getModels().filter(model=>model.api==='openai-codex-responses'||model.api.startsWith('google-')).filter(model=>model.inputLimits?.maxRequestBytes!==undefined||model.inputLimits?.images?.maxPerMessage!==undefined||model.inputLimits?.images?.maxPerRequest!==undefined).map(model=>({provider:model.provider,id:model.id,api:model.api,inputLimits:model.inputLimits}));
 await writeFile(new URL('../../../.agents/evidence/2026-11-10-complete-desktop-model-settings/sdk-native-quota-metadata.json',import.meta.url),JSON.stringify(rows,null,2));expect(Array.isArray(rows)).toBe(true);
});

it('native Google directory quotas do not change legacy calls, while explicit JSONC overrides fail closed',async()=>{
 const{real,root}=await fixture();const native=real.getModels('google').find(model=>model.inputLimits?.maxRequestBytes!==undefined)!;expect(native).toBeDefined();expect(real.getRegisteredProviderConfig('fixture')).toBeUndefined();
 let calls=0;const original=real.streamSimple.bind(real);const options={apiKey:'fixture-key',maxRetries:0,fetch:(async()=>{throw new Error('must not send');})as typeof fetch};const context={messages:[]};
 real.streamSimple=(model,ctx,opts)=>{calls++;expect(opts).toBe(options);return original(model,ctx,opts);};
 const raw=guardModelInputLimits(real,{modelsPath:join(root,'models.json')});const result=await raw.streamSimple(native,context,options).result();expect(calls).toBe(1);expect(result.errorMessage).not.toContain('输入限制暂不支持');
 await writeFile(join(root,'models.json'),`// explicit quota, no credential data\n{"providers":{"google":{"modelOverrides":{${JSON.stringify(native.id)}:{"inputLimits":{"maxRequestBytes":100}}}}}}`);
 expect(()=>raw.streamSimple({...native,inputLimits:{...native.inputLimits,maxRequestBytes:100}},context,options)).toThrow('输入限制暂不支持');expect(calls).toBe(1);
});

it('Anthropic real server-thread continuation enforces only the final sent images, not omitted cached history',async()=>{
 const{runtime,model}=await fixture('anthropic-messages',{images:{maxPerRequest:1}});const threaded={...model,compat:{...model.compat,supportsMessageThreads:true}};const bodies:any[]=[];const onPayloadCounts:number[]=[];
 const sse=(id:string)=>[{type:'message_start',message:{id,type:'message',role:'assistant',model:'A',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture reply'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}].map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
 const options={apiKey:'fixture-key',maxRetries:0,sessionId:'model-input-thread-fixture',onPayload:(payload:unknown)=>{onPayloadCounts.push((JSON.stringify(payload).match(/"type":"image"/g)??[]).length);},fetch:(async(_url,init)=>{const{zstdDecompressSync}=await import('node:zlib');let bytes=Buffer.from(await new Response(init?.body).arrayBuffer());if(new Headers(init?.headers).get('content-encoding')==='zstd')bytes=zstdDecompressSync(bytes);bodies.push(JSON.parse(bytes.toString()));return new Response(sse('fixture-reply-'+bodies.length),{status:200,headers:{'content-type':'text/event-stream'}});})as typeof fetch};
 const firstUser={role:'user' as const,content:[image]as never,timestamp:1};const first=await runtime.completeSimple(threaded,{messages:[firstUser]},options);expect(first.stopReason).toBe('stop');
 const second=await runtime.completeSimple(threaded,{messages:[firstUser,first,{role:'user',content:[image]as never,timestamp:3}]},options);expect(second.stopReason).toBe('stop');expect(bodies).toHaveLength(2);expect(bodies[1].thread.type).toBe('continue');expect(onPayloadCounts).toEqual([1,2]);expect((JSON.stringify(bodies[1]).match(/"type":"image"/g)??[]).length).toBe(1);
});
