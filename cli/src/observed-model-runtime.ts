import { RequestObservations,requestObservations } from '../../extensions/_shared/requestObservation.js';

export interface RuntimeObservationOptions {
 hub?:RequestObservations;
 identity:()=>{sessionId:string;sessionPath?:string;requestId?:string};
}
/** Per-session facade over public methods; the real SDK runtime still owns auth,
 * request construction, retry and provider state. Private fields are never read. */
export function observeModelRuntime<T extends object>(runtime:T,options:RuntimeObservationOptions):T {
 const hub=options.hub??requestObservations;const bound=new Map<PropertyKey,unknown>();
 return new Proxy(runtime,{
  get(target,key){
   const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
   if(bound.has(key))return bound.get(key);
   if(!['stream','streamSimple','complete','completeSimple'].includes(String(key))){const fn=value.bind(target);bound.set(key,fn);return fn;}
   const fn=(model:any,context:any,requestOptions:any={})=>{
    // Freeze this call now. Warm requests copy SDK options but always enter here
    // again; our wrappers were only added to a copy, so replay cannot nest them.
    const identity=options.identity();
    const category=requestOptions.disableContinuation===true&&requestOptions.maxTokens===1&&requestOptions.maxRetries===0?'cache-warm':identity.sessionId.startsWith('diagnostics:')?'diagnostics':requestOptions.sessionId&&requestOptions.sessionId!==identity.sessionId?'auxiliary':'session';
    const scope=hub.begin({...identity,category,provider:model.provider,api:model.api,requestedModel:model.id});
    const onResponse=requestOptions.onResponse;const onProviderStreamEvent=requestOptions.onProviderStreamEvent;
    const wrapped={...requestOptions,
     onResponse:async(response:unknown,...rest:unknown[])=>{scope.response(response);return onResponse?.(response,...rest);},
     onProviderStreamEvent:async(event:unknown,...rest:unknown[])=>{scope.raw(event);return onProviderStreamEvent?.(event,...rest);},
    };
    let removeAbort=()=>{};
    if(requestOptions.signal){const cancel=()=>scope.finish('cancelled');requestOptions.signal.addEventListener('abort',cancel,{once:true});removeAbort=()=>requestOptions.signal.removeEventListener('abort',cancel);if(requestOptions.signal.aborted)cancel();}
    const finish=(message:any)=>{removeAbort();scope.finish(message?.stopReason==='aborted'?'cancelled':message?.stopReason==='error'?'failed':'completed',message);};
    try{
     const result=value.call(target,model,context,wrapped);
     if(result&&typeof result.result==='function')void result.result().then(finish,()=>{removeAbort();scope.finish('failed');});
     else if(result&&typeof result.then==='function')void result.then(finish,()=>{removeAbort();scope.finish('failed');});
     return result;
    }catch(e){removeAbort();scope.finish('failed');throw e;}
   };
   bound.set(key,fn);return fn;
  },
 });
}
