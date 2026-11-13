import {expect,it} from 'vitest';
import {RequestObservationService,warmingSnapshot} from './requestObservationService';
import {RequestObservations} from '../../../extensions/_shared/requestObservation.js';
it('exports only a frozen preview, preserves it after later chunks and expires it on close',async()=>{
 const hub=new RequestObservations('g');const service=new RequestObservationService({hub});const r=hub.begin({sessionId:'a',provider:'p',api:'x',requestedModel:'m'});await service.command({action:'collect',identity:r.identity,enabled:true});r.raw({index:1});const p=await service.command({action:'preview',identity:r.identity});r.raw({index:2});
 expect((await service.command({action:'readPreview',previewId:p.previewId})).events).toEqual([{index:1}]);
 await service.command({action:'clear',identity:r.identity});await expect(service.command({action:'readPreview',previewId:p.previewId})).rejects.toThrow('expired');
});
it('whitelists official getter state without changing scheduling',()=>{
 let reads=0;const session={sessionId:'a',get cacheWarmingStatus(){reads++;return {state:'scheduled',nextWarmAt:12,decision:{warmCost:0,missCost:0.12,continuationProbability:0.15,action:'warm',economicsAvailable:true,secret:'no'},extensionOverride:true};}};
 expect(warmingSnapshot(session)).toEqual({sessionId:'a',availability:'supported',status:{state:'scheduled',nextWarmAt:12,decision:{warmCost:0,missCost:0.12,continuationProbability:0.15,action:'warm',economicsAvailable:true},extensionOverride:true}});expect(reads).toBe(1);expect(warmingSnapshot(null)).toEqual({availability:'unavailable'});
});
it('drops a frozen remote preview immediately when its worker disconnects',async()=>{
 const hub=new RequestObservations('host');const service=new RequestObservationService({hub});const identity={sessionId:'remote',requestId:'r',runtimeGeneration:'worker'};const state:any={identity,sequence:1,phase:'completed',availability:'supported',collecting:false,events:[{index:1}],responses:[]};
 hub.acceptRemote(state,async()=>({previewId:'remote-preview',identity,version:1,events:[{index:1}]}));await service.command({action:'preview',identity});hub.disconnectRemote('worker');await expect(service.command({action:'readPreview',previewId:'remote-preview'})).rejects.toThrow('expired');
});
