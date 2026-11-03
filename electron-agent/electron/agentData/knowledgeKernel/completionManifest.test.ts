import { describe, it, expect } from 'vitest';
import { buildCompletionManifest, validateCompletionManifest, type KnowledgeCompletionRequirements } from './completionManifest';
import { hashKnowledgePayload, type VerifiedArtifact } from './store';
const requirements: KnowledgeCompletionRequirements = { domain:'wiki',pipelineConfigHash:'p',sourceSnapshotId:'s',structureHash:'c',required:[{phase:'generate',itemId:'generate:a',kind:'page',inputHash:'ia'},{phase:'generate',itemId:'generate:b',kind:'page',inputHash:'ib'}] };
const checkpoint=(itemId:string,inputHash:string,markdown:string):VerifiedArtifact=>{const payload={markdown,sources:[]};return {taskId:'t',phase:'generate',itemId,attempt:1,revision:1,inputHash,outputHash:hashKnowledgePayload(payload),state:'prepared',payload,evidence:[],dependencies:[]};};
const checkpoints=[checkpoint('generate:a','ia','A'),checkpoint('generate:b','ib','B')];
describe('completion manifest',()=>{
 it('requires every independently frozen page with matching input, nonempty body and authentic output',()=>{
  const manifest=buildCompletionManifest(requirements,checkpoints);expect(()=>validateCompletionManifest(manifest,requirements,checkpoints)).not.toThrow();
  expect(()=>buildCompletionManifest(requirements,checkpoints.slice(0,1))).toThrow();
  expect(()=>buildCompletionManifest(requirements,[checkpoints[0],checkpoint('generate:b','ib','  ')])).toThrow();
  expect(()=>validateCompletionManifest({...manifest,sourceSnapshotId:'other'},requirements,checkpoints)).toThrow();
  expect(()=>validateCompletionManifest({...manifest,required:manifest.required.slice(0,1)},requirements,checkpoints)).toThrow();
  expect(()=>validateCompletionManifest(manifest,requirements,[checkpoints[0],{...checkpoints[1],outputHash:'forged'}])).toThrow();
  expect(()=>validateCompletionManifest(manifest,requirements,[checkpoints[0],{...checkpoints[1],state:'failed'}])).toThrow();
 });
 it('accepts cards and relations without requiring markdown for relations',()=>{
  const r:KnowledgeCompletionRequirements={...requirements,domain:'cards',required:[{phase:'generate',itemId:'card:repository',kind:'repository-card',inputHash:'ir'},{phase:'relations',itemId:'relations',kind:'relations',inputHash:'it'}]};
  const relPayload={relations:[]};const items=[checkpoint('card:repository','ir','Repository'),{...checkpoint('relations','it','x'),phase:'relations' as const,payload:relPayload,outputHash:hashKnowledgePayload(relPayload)}];
  expect(()=>buildCompletionManifest(r,items)).not.toThrow();expect(()=>buildCompletionManifest(r,items.slice(0,1))).toThrow();
 });
});
