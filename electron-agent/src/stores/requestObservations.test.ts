import {expect,it} from 'vitest';import {mergeObservation} from './requestObservations';
const event=(sessionId:string,requestId:string,sequence:number,phase='started',generation='g1')=>({identity:{sessionId,requestId,runtimeGeneration:generation},sequence,phase,events:[]}) as any;
it('isolates A/B and rejects old sequence, terminal late data and superseded host generation',()=>{
 let s:any={};s=mergeObservation(s,event('a','r',1));s=mergeObservation(s,event('b','r',2));s=mergeObservation(s,event('a','r',3,'cancelled'));s=mergeObservation(s,event('a','r',4,'response'));expect(Object.values(s)).toHaveLength(2);expect((Object.values(s)[0] as any).phase).toBe('cancelled');
 s=mergeObservation(s,event('a','new',1,'started','g2'));s=mergeObservation(s,event('a','late',9,'started','g1'));expect(Object.values(s)).toHaveLength(3);expect(Object.values(s).some((r:any)=>r.identity.requestId==='late')).toBe(false);
});
