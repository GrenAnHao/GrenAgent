import assert from 'node:assert/strict';
import test from 'node:test';
import { observeModelRuntime } from './observed-model-runtime.js';
import { RequestObservations } from '../../extensions/_shared/requestObservation.js';
test('per-session facade leaves shared runtime APIs bound, callbacks intact, each warm/options replay gets a new scope',async()=>{
 const hub=new RequestObservations('g');const callbacks:any[]=[];
 class Runtime { value=1; refresh(){this.value++;} getModel(){return this.value;} streamSimple(_m:any,_c:any,o:any){callbacks.push(o);const p=(async()=>{await o.onResponse({status:200,headers:{'request-id':'r'}});await o.onProviderStreamEvent({type:'text_delta',text:'SECRET'});return {usage:{cost:{total:0,totalFromProvider:false}}};})();return {result:()=>p};} }
 const native=new Runtime();const a=observeModelRuntime(native,{hub,identity:()=>({sessionId:'a'})});const b=observeModelRuntime(native,{hub,identity:()=>({sessionId:'b'})});
 let count=0;const opts={onResponse:()=>{count++;}};const model={provider:'p',api:'api',id:'m'};
 await a.streamSimple(model,{},opts).result();await a.streamSimple(model,{},opts).result();await b.streamSimple(model,{},opts).result();
 assert.equal(count,3);assert.equal(hub.list().length,3);assert.notEqual(hub.list()[0].identity.requestId,hub.list()[1].identity.requestId);assert.deepEqual(hub.list().map(r=>r.identity.sessionId),['a','a','b']);
 a.refresh();assert.equal(b.getModel(),2);assert.equal(native.value,2);assert.equal(opts.onResponse instanceof Function,true);assert.equal(JSON.stringify(hub.list()).includes('SECRET'),false);
});
