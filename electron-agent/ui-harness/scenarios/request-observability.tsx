import {useState}from'react';import{CurrentRequestDetails}from'../../src/features/chat/RequestDetails';import{installBridge,exposeActions,track}from'../stubs';
import type{RequestObservation}from'../../../extensions/_shared/requestObservation';
const make=(sessionId:string):RequestObservation=>({identity:{sessionId,runtimeGeneration:'fixture-generation',requestId:`request-${sessionId}`},sequence:1,observedAt:1,phase:'response',attempt:1,category:'session',provider:'Fixture',api:'fixture-api',requestedModel:`alias-${sessionId}`,startedAt:Date.now(),availability:'supported',responses:[{attempt:1,metadata:{httpStatus:429,providerRequestId:`safe-${sessionId}`,rateLimit:{'retry-after':'2'}}}],collecting:false,events:[],previewVersion:0});
const records=[make('A'),make('B')];const listeners=new Map<string,Set<Function>>();let preview:any=null;let failExport=true;
const emit=(s:RequestObservation)=>{s.sequence++;for(const fn of listeners.get('pi://request-observation')??[])fn({payload:structuredClone(s)});};
installBridge({subscribe:async(name:string,fn:Function)=>{const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},invoke:async(command:string,p:any)=>{
 if(command==='export_request_observation'){if(!preview||p.previewId!==preview.previewId)throw Error('expired preview');track(`export:${preview.events.length}`);if(failExport){failExport=false;throw Error('fixture write failed');}return{saved:true};}
 if(command!=='request_observation')throw Error(`unexpected ${command}`);
 if(p.action==='list')return structuredClone(records.filter(s=>s.identity.sessionId===p.sessionId));
 if(p.action==='warming')return p.sessionId==='A'?{sessionId:'A',availability:'supported',status:{state:'scheduled',nextWarmAt:Date.now()+60000,decision:{warmCost:0,missCost:0.12,continuationProbability:0.15,action:'warm',economicsAvailable:true}}}:{availability:'unavailable'};
 const r=records.find(s=>s.identity.requestId===p.identity?.requestId)!;
 if(p.action==='collect'){r.collecting=p.enabled;track(`collect:${r.identity.sessionId}:${p.enabled}`);emit(r);return true;}
 if(p.action==='clear'){r.collecting=false;r.events=[];preview=null;track(`clear:${r.identity.sessionId}`);emit(r);return;}
 if(p.action==='preview'){preview={previewId:'fixture-frozen',events:structuredClone(r.events)};return structuredClone(preview);}
 throw Error(`unexpected action ${p.action}`);
}});
exposeActions({push:()=>{const r=records[0];if(r.collecting){r.events.push({type:'text_delta',text:'[redacted]',unknownFields:{count:2}});emit(r);}},truncate:()=>{const r=records[0];r.events=Array.from({length:200},(_,index)=>({index}));r.availability='truncated';r.collecting=false;emit(r);},finish:()=>{const r=records[0];r.phase='completed';r.collecting=false;r.outcome={responseModel:'actual-A',costTotal:0.12,costSource:'provider'};emit(r);},snapshot:()=>structuredClone(records)});
export default function Scenario(){const[scope,setScope]=useState('A');return <main style={{padding:24,maxWidth:900,margin:'auto',color:'var(--gren-text)'}}><h2>请求与缓存预热</h2><div style={{display:'flex',gap:8,marginBottom:16}}><button data-testid="scope-a" onClick={()=>setScope('A')}>会话 A</button><button data-testid="scope-b" onClick={()=>setScope('B')}>会话 B</button></div><CurrentRequestDetails key={scope} sessionId={scope}/></main>;}
