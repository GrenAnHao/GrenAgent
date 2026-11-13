import {create} from 'zustand';
import type {RequestObservation,RequestIdentity} from '../../../extensions/_shared/requestObservation';
export type ObservationState=Record<string,RequestObservation>;
export const requestKey=(i:RequestIdentity)=>JSON.stringify([i.sessionId,i.runtimeGeneration,i.requestId]);
export function mergeObservation(state:ObservationState,event:RequestObservation):ObservationState {
 const key=requestKey(event.identity);const old=state[key];
 if(old&&(event.sequence<=old.sequence||(['completed','failed','cancelled'].includes(old.phase)&&old.phase!==event.phase)))return state;
 const session=Object.values(state).filter(s=>s.identity.sessionId===event.identity.sessionId);
 const latest=session.at(-1)?.identity.runtimeGeneration;
 if(latest&&latest!==event.identity.runtimeGeneration&&session.some(s=>s.identity.runtimeGeneration===event.identity.runtimeGeneration))return state;
 const next={...state};
 if(latest&&latest!==event.identity.runtimeGeneration)for(const [k,s]of Object.entries(next))if(s.identity.sessionId===event.identity.sessionId)next[k]={...s,availability:'unavailable',events:[],collecting:false};
 next[key]=event;return next;
}
export const useRequestObservations=create<{byId:ObservationState;accept:(event:RequestObservation)=>void;clear:(identity:RequestIdentity)=>void;disconnect:(identity:RequestIdentity)=>void}>((set)=>({
 disconnect:identity=>set(s=>{const key=requestKey(identity);const old=s.byId[key];return old?{byId:{...s.byId,[key]:{...old,phase:['completed','failed','cancelled'].includes(old.phase)?old.phase:'failed',availability:'unavailable',events:[],collecting:false}}}:s;}),
 byId:{},accept:event=>set(s=>({byId:mergeObservation(s.byId,event)})),
 clear:identity=>set(s=>{const key=requestKey(identity);const old=s.byId[key];return old?{byId:{...s.byId,[key]:{...old,events:[],collecting:false}}}:s;}),
}));
