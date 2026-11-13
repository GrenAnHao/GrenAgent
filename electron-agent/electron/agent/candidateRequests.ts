import type { AgentSession } from '../../../cli/src/pi-sdk.js';
const gates=new WeakMap<AgentSession,()=>void>();
/** Candidate session_start hooks cannot issue a model request or warm a cache. */
export function blockCandidateRequests(session:AgentSession):void{
  const prompt=session.prompt.bind(session),stream=session.agent.streamFunction;
  session.prompt=(async()=>{throw new Error('CANDIDATE_NOT_PUBLISHED');}) as AgentSession['prompt'];
  session.agent.streamFunction=(()=>{throw new Error('CANDIDATE_NOT_PUBLISHED');}) as typeof stream;
  gates.set(session,()=>{session.prompt=prompt;session.agent.streamFunction=stream;});
}
export function activateCandidateRequests(session:AgentSession):void{gates.get(session)?.();gates.delete(session);}
