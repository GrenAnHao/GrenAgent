import { randomUUID } from 'node:crypto';

export interface RequestIdentity { sessionId:string;sessionPath?:string;runtimeGeneration:string;requestId:string }
export type RequestPhase='started'|'response'|'completed'|'failed'|'cancelled';
export type CostSource='provider'|'catalog'|'unknown';
export interface RequestMetadata {httpStatus?:number;providerRequestId?:string;rateLimit:Record<string,string>}
export interface RequestObservation {
 identity:RequestIdentity;sequence:number;observedAt:number;phase:RequestPhase;attempt:number;
 provider:string;api:string;requestedModel:string;startedAt:number;category:'session'|'diagnostics'|'cache-warm'|'auxiliary';
 availability:'supported'|'unavailable'|'truncated';metadata?:RequestMetadata;
 responses:Array<{attempt:number;metadata:RequestMetadata}>;
 outcome?:{responseModel?:string;costTotal?:number;costSource:CostSource};
 collecting:boolean;events:unknown[];previewVersion:number;
}
export const MAX_STRUCTURE_EVENTS=200;
export const MAX_STRUCTURE_BYTES=1024*1024;
const headerNames=new Set(['request-id','x-request-id','openai-request-id','retry-after',
 ...['limit','remaining','reset'].flatMap(a=>['requests','tokens'].map(b=>`x-ratelimit-${a}-${b}`)),
 ...['requests','tokens'].flatMap(a=>['limit','remaining','reset'].map(b=>`anthropic-ratelimit-${a}-${b}`))]);
export function safeResponseMetadata(response:unknown):RequestMetadata {
 const r=response as {status?:unknown;headers?:unknown};const result:RequestMetadata={rateLimit:{}};
 if(typeof r?.status==='number'&&Number.isInteger(r.status))result.httpStatus=r.status;
 const headers=r?.headers;
 const entries=headers&&typeof (headers as any).entries==='function'?[...(headers as any).entries()]:headers&&typeof headers==='object'?Object.entries(headers):[];
 for(const [key,value] of entries){const name=String(key).toLowerCase();if(!headerNames.has(name)||typeof value!=='string')continue;const safe=value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,256);if(name.endsWith('request-id'))result.providerRequestId??=safe;else result.rateLimit[name]=safe;}
 return result;
}
const envelopeKeys=new Set(['type','object','index','sequence_number','content_index','output_index','item_index','delta','usage','message','response','item','content_block','content','text','thinking','arguments','input','output','input_tokens','output_tokens','total_tokens','cache_read_input_tokens','cache_creation_input_tokens','cached_tokens','id','stop_reason','role','data','choices','finish_reason','created','model']);
const safeTypes=new Set(['message_start','message_delta','message_stop','content_block_start','content_block_delta','content_block_stop','text_delta','thinking_delta','input_json_delta','ping','error','response.created','response.in_progress','response.completed','response.failed','response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.output_text.delta','response.output_text.done','response.function_call_arguments.delta','response.function_call_arguments.done','chat.completion.chunk']);
/** Conservative structural projection, including dynamic dictionary keys. Never mutates SDK data. */
export function safeStructure(value:unknown,depth=0):unknown {
 if(depth>12)return '[depth limit]';
 if(value===null||typeof value==='boolean'||typeof value==='number')return typeof value==='number'&&!Number.isFinite(value)?'[redacted]':value;
 if(typeof value==='string')return '[redacted]';
 if(Array.isArray(value))return value.slice(0,100).map(v=>safeStructure(v,depth+1));
 if(typeof value!=='object')return '[unavailable]';
 const result:Record<string,unknown>={};let unknown=0;
 for(const [key,v]of Object.entries(value)){
  if(!envelopeKeys.has(key)){unknown++;continue;}
  result[key]=key==='type'||key==='object'?typeof v==='string'&&safeTypes.has(v)?v:'[redacted]':safeStructure(v,depth+1);
 }
 if(unknown)result.unknownFields={count:unknown};return result;
}
export function observationKey(i:RequestIdentity):string {return JSON.stringify([i.sessionId,i.runtimeGeneration,i.requestId]);}
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export class RequestObservations {
 private requests=new Map<string,{state:RequestObservation;bytes:number}>();
 private listeners=new Set<(event:RequestObservation)=>void>();
 private sequence=0;
 private remote=new Map<string,(params:Record<string,unknown>)=>Promise<any>>();
 constructor(readonly generation:string=randomUUID()){}
 subscribe(listener:(event:RequestObservation)=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private publish(s:RequestObservation):void{s.sequence=++this.sequence;s.observedAt=Date.now();for(const listener of this.listeners){try{listener(copy(s));}catch{/* observers never affect model */}}}
 begin(input:{sessionId:string;sessionPath?:string;requestId?:string;provider:string;api:string;requestedModel:string;category?:RequestObservation['category']}) {
  const identity:RequestIdentity=Object.freeze({sessionId:input.sessionId,...(input.sessionPath?{sessionPath:input.sessionPath}:{}),runtimeGeneration:this.generation,requestId:input.requestId??randomUUID()});
  const state:RequestObservation={identity,sequence:0,observedAt:Date.now(),phase:'started',attempt:0,provider:input.provider,api:input.api,requestedModel:input.requestedModel,category:input.category??'session',startedAt:Date.now(),availability:'unavailable',responses:[],collecting:false,events:[],previewVersion:0};
  const record={state,bytes:0};this.requests.set(observationKey(identity),record);this.publish(state);
  const terminal=()=>['completed','failed','cancelled'].includes(state.phase);
  return {identity,
   response:(response:unknown)=>{if(terminal())return;try{state.metadata=safeResponseMetadata(response);state.phase='response';state.attempt++;state.availability='supported';state.responses.push({attempt:state.attempt,metadata:state.metadata});this.publish(state);}catch{/* discard */}},
   raw:(value:unknown)=>{if(terminal()||!state.collecting||state.availability==='truncated')return;try{const safe=safeStructure(value);const bytes=new TextEncoder().encode(JSON.stringify(safe)).byteLength;if(state.events.length>=MAX_STRUCTURE_EVENTS||record.bytes+bytes>MAX_STRUCTURE_BYTES){state.availability='truncated';state.collecting=false;}else{record.bytes+=bytes;state.events.push(safe);state.availability='supported';}this.publish(state);}catch{/* never fall back to raw */}},
   finish:(phase:'completed'|'failed'|'cancelled',message?:any)=>{if(terminal())return;state.phase=phase;state.collecting=false;if(message){const cost=message.usage?.cost;state.outcome={...(typeof message.responseModel==='string'?{responseModel:message.responseModel}:{}),...(typeof cost?.total==='number'?{costTotal:cost.total}:{}),costSource:cost?.totalFromProvider===true?'provider':cost?'catalog':'unknown'};}this.publish(state);},
  };
 }
 snapshot(identity:RequestIdentity):RequestObservation|null{return copy(this.requests.get(observationKey(identity))?.state??null);}
 list(sessionId?:string):RequestObservation[]{return [...this.requests.values()].filter(r=>!sessionId||r.state.identity.sessionId===sessionId).map(r=>copy(r.state));}
 collect(identity:RequestIdentity,enabled:boolean):boolean{const r=this.requests.get(observationKey(identity));if(!r)return false;if(enabled&&['completed','failed','cancelled'].includes(r.state.phase))return false;r.state.collecting=enabled;if(!enabled){r.state.events=[];r.bytes=0;}this.publish(r.state);return true;}
 clear(identity:RequestIdentity):void{this.collect(identity,false);}
 preview(identity:RequestIdentity):{version:number;identity:RequestIdentity;events:unknown[]}|null{const r=this.requests.get(observationKey(identity));if(!r)return null;r.state.previewVersion++;return copy({version:r.state.previewVersion,identity:r.state.identity,events:r.state.events});}
 acceptRemote(event:RequestObservation,forward:(params:Record<string,unknown>)=>Promise<any>):void {
  const key=observationKey(event.identity);const old=this.requests.get(key)?.state;
  if(old&&(old.sequence>=event.sequence||(['completed','failed','cancelled'].includes(old.phase)&&old.phase!==event.phase)))return;
  this.remote.set(event.identity.runtimeGeneration,forward);this.requests.set(key,{state:copy(event),bytes:0});
  for(const listener of this.listeners)try{listener(copy(event));}catch{}
 }
 forwardRemote(identity:RequestIdentity,params:Record<string,unknown>):Promise<any>|undefined{return this.remote.get(identity.runtimeGeneration)?.(params);}
 disconnectRemote(generation:string):void {
  this.remote.delete(generation);
  for(const r of this.requests.values())if(r.state.identity.runtimeGeneration===generation){r.state.events=[];r.state.collecting=false;r.state.availability='unavailable';if(!['completed','failed','cancelled'].includes(r.state.phase))r.state.phase='failed';r.state.sequence++;for(const listener of this.listeners)try{listener(copy(r.state));}catch{}}
 }
 clearAll():void{for(const r of this.requests.values()){r.state.events=[];r.state.collecting=false;r.bytes=0;}this.requests.clear();}
}
export const requestObservations=new RequestObservations();
