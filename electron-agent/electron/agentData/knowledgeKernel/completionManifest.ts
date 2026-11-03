import type { KnowledgeDomain, KnowledgePhase, KnowledgeStageKind } from '../../../shared/knowledgeKernelContracts';
import { hashKnowledgePayload, type VerifiedArtifact } from './store';
export interface KnowledgeCompletionRequirements { domain: KnowledgeDomain; pipelineConfigHash: string; sourceSnapshotId: string; structureHash: string; required: Array<{ phase: KnowledgePhase; itemId: string; kind: KnowledgeStageKind; inputHash: string }> }
export interface KnowledgeCompletionManifest extends Omit<KnowledgeCompletionRequirements, 'required'> { version: 2; required: Array<KnowledgeCompletionRequirements['required'][number] & { outputHash: string }>; failedOrBlocked: Array<{ phase: KnowledgePhase; itemId: string }> }
export function buildCompletionManifest(requirements: KnowledgeCompletionRequirements, checkpoints: VerifiedArtifact[]): KnowledgeCompletionManifest {
 const key=(x:{phase:KnowledgePhase;itemId:string})=>JSON.stringify([x.phase,x.itemId]);
 const byId=new Map(checkpoints.map(item=>[key(item),item]));
 if(byId.size!==checkpoints.length||!requirements.required.length||new Set(requirements.required.map(key)).size!==requirements.required.length||checkpoints.some(item=>item.state==='failed'||item.state==='blocked'))throw new Error('REQUIRED_ITEMS_INCOMPLETE');
 const required=requirements.required.map(expected=>{
  const item=byId.get(key(expected));if(!item||item.state!=='prepared'||item.inputHash!==expected.inputHash||hashKnowledgePayload(item.payload)!==item.outputHash)throw new Error('REQUIRED_ITEMS_INCOMPLETE');
  if(expected.kind==='relations') { if(!item.payload||typeof item.payload!=='object'||!Array.isArray((item.payload as {relations?:unknown}).relations))throw new Error('INVALID_RELATIONS'); }
  else if(!item.payload||typeof item.payload!=='object'||typeof (item.payload as {markdown?:unknown}).markdown!=='string'||!(item.payload as {markdown:string}).markdown.trim())throw new Error('INVALID_ARTIFACT');
  for(const dep of item.dependencies){const target=byId.get(key(dep));if(!target||target.state!=='prepared'||target.outputHash!==dep.outputHash)throw new Error('DEPENDENCY_MISMATCH');}
  return {...expected,outputHash:item.outputHash};
 });
 return {version:2,domain:requirements.domain,pipelineConfigHash:requirements.pipelineConfigHash,sourceSnapshotId:requirements.sourceSnapshotId,structureHash:requirements.structureHash,required,failedOrBlocked:[]};
}
export function validateCompletionManifest(manifest: KnowledgeCompletionManifest, requirements: KnowledgeCompletionRequirements, checkpoints: VerifiedArtifact[]): void {
 const actual=buildCompletionManifest(requirements,checkpoints);if(JSON.stringify(manifest)!==JSON.stringify(actual))throw new Error('COMPLETION_MANIFEST_MISMATCH');
}

export function requirementsFromGraph(graph: import('./pipeline').StageGraph, pipelineConfigHash: string, sourceSnapshotId: string, checkpoints: VerifiedArtifact[]): KnowledgeCompletionRequirements {
 const catalogue=checkpoints.find(item=>item.itemId==='catalogue:complete'&&item.phase==='catalogue');
 const structureHash=graph.domain==='wiki' ? (catalogue?.payload as {catalogueHash?:string}|undefined)?.catalogueHash : hashKnowledgePayload([graph.definitions,graph.nodes.filter(n=>n.phase==='generate'||n.phase==='relations').map(n=>[n.id,n.kind,n.deps])]);
 if(!structureHash)throw new Error('CATALOGUE_INCOMPLETE');
 const required=graph.nodes.filter(n=>['page','module-card','repository-card','relations'].includes(n.kind)).map(n=>({phase:n.phase,itemId:n.id,kind:n.kind as KnowledgeStageKind,inputHash:n.inputHash}));
 return {domain:graph.domain,pipelineConfigHash,sourceSnapshotId,structureHash,required};
}
