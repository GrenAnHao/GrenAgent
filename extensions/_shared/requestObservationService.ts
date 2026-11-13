import {randomUUID} from 'node:crypto';
import {requestObservations,type RequestObservations,type RequestIdentity} from './requestObservation.js';
export interface WarmingSnapshot {sessionId?:string;availability:'supported'|'unavailable';status?:{state:string;reason?:string;nextWarmAt?:number;extensionOverride?:boolean;decision?:{warmCost?:number;missCost?:number;continuationProbability?:number;action?:string;economicsAvailable?:boolean}}}
export class RequestObservationService {
 private previews=new Map<string,{previewId:string;identity:RequestIdentity;version:number;events:unknown[]}>();
 private stop:()=>void;
 constructor(private options:{hub?:RequestObservations;warming?:(p:Record<string,unknown>)=>WarmingSnapshot;fallback?:(p:Record<string,unknown>)=>Promise<any>}={}){
  this.stop=this.hub.subscribe(event=>{if(!event.collecting&&!event.events.length)for(const [id,p]of this.previews)if(p.identity.requestId===event.identity.requestId&&p.identity.runtimeGeneration===event.identity.runtimeGeneration)this.previews.delete(id);});
 }
 private get hub(){return this.options.hub??requestObservations;}
 async command(p:Record<string,unknown>):Promise<any>{
  const action=p.action;const identity=p.identity as RequestIdentity|undefined;
  if(action==='list'){
   const local=this.hub.list(typeof p.sessionId==='string'?p.sessionId:undefined).filter(s=>typeof p.sessionPath!=='string'||s.identity.sessionPath===p.sessionPath);
   const remote=this.options.fallback?await this.options.fallback(p):[];return [...local,...remote];
  }
  if(action==='warming'){
   const local=this.options.warming?.(p);if(local?.availability==='supported')return local;
   const remote=this.hub.list(typeof p.sessionId==='string'?p.sessionId:undefined).find(s=>(typeof p.sessionPath!=='string'||s.identity.sessionPath===p.sessionPath)&&s.identity.runtimeGeneration!==this.hub.generation);
   const forwarded=remote?this.hub.forwardRemote(remote.identity,p):undefined;if(forwarded)return forwarded;
   return this.options.fallback?.(p)??local??{availability:'unavailable'};
  }
  if(action==='readPreview'){
   const preview=this.previews.get(String(p.previewId));if(preview)return structuredClone(preview);
   if(this.options.fallback)return this.options.fallback(p);throw new Error('Diagnostic preview expired');
  }
  if(!identity||typeof identity.sessionId!=='string'||typeof identity.requestId!=='string'||typeof identity.runtimeGeneration!=='string')throw new Error('Request identity is required');
  if(identity.runtimeGeneration!==this.hub.generation){const pending=this.hub.forwardRemote(identity,p);if(pending){const result=await pending;if(action==='preview'&&result?.previewId)this.previews.set(result.previewId,result);if(action==='clear')for(const [id,v]of this.previews)if(v.identity.requestId===identity.requestId)this.previews.delete(id);return result;}if(this.options.fallback)return this.options.fallback(p);return null;}
  if(action==='collect'){if(p.enabled!==true)for(const [id,v]of this.previews)if(v.identity.requestId===identity.requestId)this.previews.delete(id);return this.hub.collect(identity,p.enabled===true);}
  if(action==='clear'){
   this.hub.clear(identity);for(const [id,v]of this.previews)if(v.identity.requestId===identity.requestId&&v.identity.runtimeGeneration===identity.runtimeGeneration)this.previews.delete(id);return null;
  }
  if(action==='preview'){
   const value=this.hub.preview(identity);if(!value)return null;
   for(const [id,v]of this.previews)if(v.identity.requestId===identity.requestId)this.previews.delete(id);
   const preview={...value,previewId:randomUUID()};this.previews.set(preview.previewId,preview);return structuredClone(preview);
  }
  throw new Error('Unknown observation action');
 }
 clear():void{this.stop();this.previews.clear();this.hub.clearAll();}
}
/** Whitelist the public SDK getter. Reading this never schedules or writes settings. */
export function warmingSnapshot(session:any):WarmingSnapshot {
 try{
  const s=session?.cacheWarmingStatus;if(!s||!['inactive','scheduled','refreshing'].includes(s.state))return {availability:'unavailable'};
  const status:NonNullable<WarmingSnapshot['status']>={state:s.state};
  if(typeof s.reason==='string')status.reason=s.reason.slice(0,256);
  if(typeof s.nextWarmAt==='number')status.nextWarmAt=s.nextWarmAt;
  if(typeof s.extensionOverride==='boolean')status.extensionOverride=s.extensionOverride;
  if(s.decision&&typeof s.decision==='object'){
   status.decision={};for(const k of ['warmCost','missCost','continuationProbability'] as const)if(typeof s.decision[k]==='number')status.decision[k]=s.decision[k];
   if(['warm','stop'].includes(s.decision.action))status.decision.action=s.decision.action;
   if(typeof s.decision.economicsAvailable==='boolean')status.decision.economicsAvailable=s.decision.economicsAvailable;
  }
  return {sessionId:session.sessionId,availability:'supported',status};
 }catch{return {availability:'unavailable'};}
}
