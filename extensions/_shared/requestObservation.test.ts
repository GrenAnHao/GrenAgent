import { expect,it } from 'vitest';
import { RequestObservations,safeStructure,safeResponseMetadata } from './requestObservation.js';
it('drops unknown headers, keys and every non-envelope string before IPC',()=>{
 const secret='VERY_SECRET';const raw={type:'content_block_delta',delta:{type:'text_delta',text:secret,[secret]:secret},[secret]:{token:secret},usage:{input_tokens:3},index:1};
 const projected=safeStructure(raw);expect(JSON.stringify(projected)).not.toContain(secret);expect(projected).toMatchObject({type:'content_block_delta',index:1,usage:{input_tokens:3}});
 expect(safeResponseMetadata({status:429,headers:{Authorization:secret,'Set-Cookie':secret,'X-Request-Id':'r1','Retry-After':'2','unknown':secret}})).toEqual({httpStatus:429,providerRequestId:'r1',rateLimit:{'retry-after':'2'}});
});
it('creates isolated identities, numbers observed responses, ignores late/duplicate generations and freezes raw lifecycle',()=>{
 const hub=new RequestObservations('g1');const events:any[]=[];hub.subscribe(e=>events.push(JSON.parse(JSON.stringify(e))));
 const a=hub.begin({sessionId:'a',provider:'p',api:'x',requestedModel:'m'});const b=hub.begin({sessionId:'b',provider:'p',api:'x',requestedModel:'m'});
 a.raw({type:'text_delta',text:'before'});expect(hub.snapshot(a.identity)?.events).toEqual([]);
 hub.collect(a.identity,true);a.raw({type:'text_delta',text:'secret'});a.response({status:429,headers:{'request-id':'r1'}});a.response({status:200,headers:{}});a.finish('cancelled');a.raw({index:9});
 expect(hub.snapshot(a.identity)).toMatchObject({phase:'cancelled',attempt:2,collecting:false,events:[{type:'text_delta',text:'[redacted]'}]});
 expect(hub.snapshot(b.identity)).toMatchObject({phase:'started',attempt:0,events:[]});
 const preview=hub.preview(a.identity);expect(preview?.events).toHaveLength(1);hub.clear(a.identity);expect(hub.snapshot(a.identity)?.events).toEqual([]);expect(hub.collect(a.identity,true)).toBe(false);
 expect(events.every(e=>!JSON.stringify(e).includes('secret'))).toBe(true);
});
it('caps collection at 200 events and freezes exactly the preview version',()=>{
 const hub=new RequestObservations('g');const r=hub.begin({sessionId:'a',provider:'p',api:'x',requestedModel:'m'});hub.collect(r.identity,true);
 r.raw({index:1});const preview=hub.preview(r.identity)!;r.raw({index:2});expect(preview.events).toHaveLength(1);
 for(let i=0;i<220;i++)r.raw({index:i});expect(hub.snapshot(r.identity)).toMatchObject({availability:'truncated'});expect(hub.snapshot(r.identity)?.events).toHaveLength(200);
});
it('redacts nested secrets and dynamic keys, bounds bytes, and drops unsafe getters without affecting requests',()=>{
 const secret='SECRET_ALL_LOCATIONS';const raw=Object.freeze({type:'unknown-secret-type',message:{content:[{text:secret,thinking:secret,arguments:{[secret]:secret}}],data:{Authorization:secret,cookies:[secret]}},[secret]:secret,usage:{input_tokens:3}});
 expect(JSON.stringify(safeStructure(raw))).not.toContain(secret);expect(raw.message.content[0].text).toBe(secret);
 const hub=new RequestObservations('bounded');const r=hub.begin({sessionId:'s',provider:'p',api:'a',requestedModel:'m'});hub.collect(r.identity,true);
 r.raw(Object.defineProperty({},'type',{enumerable:true,get(){throw Error(secret);}}));expect(hub.snapshot(r.identity)?.events).toEqual([]);
 r.raw({delta:Array.from({length:100},()=>Array.from({length:100},()=>Array(100).fill(123456)))});expect(hub.snapshot(r.identity)).toMatchObject({availability:'truncated',events:[],collecting:false});r.finish('completed');expect(hub.snapshot(r.identity)?.phase).toBe('completed');
});
