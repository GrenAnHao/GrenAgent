import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { realpathSync, lstatSync, readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { ProjectFiles, type ProjectFacts, type ProjectPublicationClaim } from '../../vendor/repo-wiki/packages/core/src/project-files';
import { WorkspaceEngine, three_way_merge } from '../../vendor/repo-wiki/packages/core/src/engine';
import { hash, scanKnowledgeSnapshot, safeRelative, matches } from '../../vendor/repo-wiki/packages/core/src/scanner';
import { knowledgeExecutionPolicySchema, type KnowledgeExecutionPolicyV2, type ExecutionFence, type KnowledgeKey, type PublishClaim, type StageArtifact } from '../../shared/knowledgeKernelContracts';
import type { Definition } from '../agentData/knowledgeKernel/pipeline';
import { normalizeStageSources, normalizeWikiNavigation, validateStageResult } from '../agentData/knowledgeKernel/validation';
import {buildWikiStageGraph,advanceStageGraph,type StageGraph} from '../agentData/knowledgeKernel/pipeline';
import {buildCardStageGraph} from '../agentData/knowledgeKernel/cardPipeline';
import {hashKnowledgePayload,type VerifiedArtifact} from '../agentData/knowledgeKernel/store';
import {requirementsFromGraph,validateCompletionManifest,type KnowledgeCompletionManifest} from '../agentData/knowledgeKernel/completionManifest';

type Domain='wiki'|'cards';
interface Source {files:Record<string,{hash:string;lines:number}>; hashes:Record<string,string>; edges:[string,string][]; coverage:'complete'|'partial'; identity:Record<string,unknown>;git:{kind:'git'|'non-git'|'error';message?:string};sourceHash:string;scopeHash:string}
interface Artifact { markdown:string; sources:Array<{path:string;hash:string;start:number;end:number}>; inputManifest?:unknown; navigationWarnings?:unknown }
interface PublicationInput {taskId:string;key:KnowledgeKey;fence:ExecutionFence;sourceSnapshot:Source;definitions:Definition[];artifacts:Record<string,Artifact>;publicationId:string;pipelineConfigHash:string;planHash:string;planToken:string;modelIdentity:string;checkpoints?:StageArtifact[];graph?:unknown;executionPolicy?:KnowledgeExecutionPolicyV2;runMaxItems?:number}
interface Candidate { input:PublicationInput; facts:ProjectFacts; files:ProjectFiles; namespace:string; intentHash:string; outputSetHash:string; planToken:string; root:string }
function branch(root:string):string {
 const options={encoding:'utf8' as const,windowsHide:true,stdio:['ignore','pipe','pipe'] as ['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'}};
 try {execFileSync('git',['-C',root,'rev-parse','--is-inside-work-tree'],options);try{return execFileSync('git',['-C',root,'symbolic-ref','--short','HEAD'],options).trim();}catch{const commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],options).trim();return `detached:${commit.slice(0,12)}`;}}
 catch(error){const stderr=String((error as {stderr?:unknown}).stderr??'');if(/not a git repository/i.test(stderr))return 'local';throw new Error('GIT_PROBE_FAILED');}
}
const namespace=(branchName:string,language:string,domain:Domain)=>hash(domain==='wiki'?[branchName,language]:[branchName,language,'knowledge-cards-v1']).slice(0,24);
export class KnowledgeProjectPort {
 private candidates=new Map<string,Candidate>();
 constructor(private readonly engine:WorkspaceEngine) {}
 read(projectId:string,domain:Domain) {
  this.engine.refreshKnowledgeProject(projectId);const project=this.engine.get_project(projectId);const root=realpathSync(project.path);const files=new ProjectFiles(root,project.language);const facts=files.load();
  const portableProjectId=String(facts.project.id);const workspaceInstanceId=hash(['repo-wiki-workspace-v1',process.platform==='win32'?root.toLowerCase():root]);const scope=hash([workspaceInstanceId,portableProjectId,project.language]);
  const key:KnowledgeKey={workspaceInstanceId,projectId,portableProjectId,branch:branch(root),language:project.language,domain};const ns=namespace(key.branch,key.language,domain);const stored=facts.pages[ns]??{};const pages:Record<string,typeof stored[string]>=Object.create(null);
  for(const [id,page] of Object.entries(stored)){const logical=domain==='cards'?(page.inputManifest?.logicalId??(id.startsWith('cards/')?id.slice(6):id)):id;if(pages[logical])throw new Error('DUPLICATE_CARD_ID');pages[logical]=domain==='cards'?{...page,id:logical,dependencies:Array.isArray(page.dependencies)?page.dependencies.map((dep:string)=>dep.startsWith('cards/')?dep.slice(6):dep):page.dependencies}:page;}
  const snapshot=facts.snapshots[ns];
  return {projectId,root,language:key.language,key,scope,planToken:hash(facts.project.plan),plan:facts.project.plan,guardFloor:files.readExecutionGuard()?.generation??0,content:{publishedCount:Object.values(pages).filter(p=>p.status!=='archived').length},published:{pages,baseline:snapshot?.kernelBaseline},baseline:snapshot?.kernelBaseline,namespace:ns};
 }
 async prepare(projectId:string,domain:Domain,signal?:AbortSignal) {
  const metadata=this.read(projectId,domain);const scan=await scanKnowledgeSnapshot(metadata.root,{include:metadata.plan.include,exclude:metadata.plan.exclude,dataDir:this.engine.data_dir,language:metadata.language},signal);
  if(scan.git.kind==='error')throw new Error(scan.git.message==='GIT_DUBIOUS_OWNERSHIP'?'GIT_DUBIOUS_OWNERSHIP':'GIT_PROBE_FAILED');if(scan.coverage.partial)throw new Error('SOURCE_COVERAGE_INCOMPLETE');if(scan.identity.branch!==metadata.key.branch)throw new Error('SOURCE_IDENTITY_CHANGED');
  const ignoreRules=ignore();const ignoreContent:Record<string,string>={};for(const name of ['.gitignore','.repowikiignore']){const file=path.join(metadata.root,name);try{const stat=lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=100_000){const text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));ignoreRules.add(text);ignoreContent[name]=text;}}catch{/* The scanner owns invalid or unreadable ignore-file coverage. */}}
  for(const relative of Object.keys(metadata.baseline?.sourceSnapshot?.hashes??{})) if(!(relative in scan.hashes)) { safeRelative(relative);if(!matches(relative,metadata.plan.include)||matches(relative,metadata.plan.exclude)||ignoreRules.ignores(relative))continue;try { lstatSync(path.join(metadata.root,...relative.split('/'))); throw new Error('SOURCE_COVERAGE_INCOMPLETE'); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; } }
  const files=Object.fromEntries(scan.files.map(f=>[f.path,{hash:f.hash,lines:f.lines}]));const scopeHash=hash([metadata.plan.include,metadata.plan.exclude,ignoreContent]);const source:Source={files,hashes:scan.hashes,edges:scan.edges,coverage:'complete',identity:scan.identity,git:scan.git,sourceHash:hash([scan.hashes,scan.edges]),scopeHash};this.engine.recordKnowledgeScan(projectId,scan);
  return {...metadata,source};
 }
 async readReadme(projectId:string,source:Source,signal?:AbortSignal) {
  const meta=this.read(projectId,'wiki');const language=meta.language.toLowerCase();
  const names=Object.keys(source.files).filter(name=>!name.includes('/')&&/^readme(?:[._-][a-z0-9-]+)?(?:\.[a-z0-9]+)?$/i.test(name));
  names.sort((a,b)=>Number(!a.toLowerCase().includes(language))-Number(!b.toLowerCase().includes(language))||a.localeCompare(b));
  const excerpts:Array<{path:string;hash:string;start:number;end:number;text:string}>=[];let remaining=65536,truncated=names.length>3;
  for(const name of names.slice(0,3)) {
   if(signal?.aborted)throw new Error('aborted');const file=path.join(meta.root,name);let bytes:Buffer;try{if(lstatSync(file).isSymbolicLink())throw new Error('FORBIDDEN_PATH');const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{if(!fstatSync(fd).isFile())throw new Error('FORBIDDEN_PATH');bytes=readFileSync(fd);}finally{closeSync(fd);}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('SNAPSHOT_CHANGED');throw error;}
   if(createHash('sha256').update(bytes).digest('hex')!==source.files[name].hash)throw new Error('SNAPSHOT_CHANGED');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const lines=text.split('\n');let selected=lines.slice(0,400).join('\n');
   if(lines.length>400)truncated=true;let encoded=Buffer.from(selected);if(encoded.length>remaining){truncated=true;encoded=encoded.subarray(0,remaining);while(encoded.length){try{selected=new TextDecoder('utf-8',{fatal:true}).decode(encoded);break;}catch{encoded=encoded.subarray(0,encoded.length-1);}}if(!encoded.length)selected='';}
   remaining-=encoded.length;excerpts.push({path:name,hash:source.files[name].hash,start:1,end:selected ? selected.split('\n').length : 0,text:selected});
  }
  return {present:names.length>0,excerpts,truncated};
 }
 installFence(projectId:string,domain:Domain,taskId:string,fence:ExecutionFence) {
  const meta=this.read(projectId,domain);const files=new ProjectFiles(meta.root,meta.language);return files.installExecutionFence({version:1,scopeIdentity:meta.scope,taskId,...fence});
 }
 async preparePublication(input:PublicationInput) {
  const prepared=await this.prepare(input.key.projectId,input.key.domain);if(hash(prepared.key)!==hash(input.key)||prepared.planToken!==input.planToken||prepared.source.sourceHash!==input.sourceSnapshot.sourceHash||prepared.source.scopeHash!==input.sourceSnapshot.scopeHash)throw new Error('PUBLICATION_INPUT_CHANGED');
  if(input.pipelineConfigHash==='knowledge-kernel-qoder-v2')this.validateV2Publication(input,prepared);
  const files=new ProjectFiles(prepared.root,prepared.language);const facts=files.load();const ns=prepared.namespace;const pages=facts.pages[ns]??{};const expected=new Set(input.definitions.map(d=>d.id));
  if(expected.size!==input.definitions.length||Object.keys(input.artifacts).length!==expected.size||[...expected].some(id=>!input.artifacts[id]))throw new Error('INCOMPLETE_PUBLICATION');
  const storedId=(id:string)=>input.key.domain==='cards'?`cards/${id}`:id;const expectedStored=new Set(input.definitions.map(def=>storedId(def.id)));
  const publicationBodies:Record<string,string>={};let revision=Number(facts.project.next_revision)||0;for(const def of input.definitions){const original=input.artifacts[def.id];const inputManifest=original.inputManifest&&typeof original.inputManifest==='object'&&!Array.isArray(original.inputManifest)?original.inputManifest as Record<string,unknown>:undefined;const checkpoint=input.checkpoints?.find(item=>item.phase==='generate'&&item.itemId===(input.key.domain==='cards'?`card:${def.id}`:`generate:${def.id}`));if(checkpoint&&inputManifest?.outputHash){const body=checkpoint.payload as Artifact;if(hashKnowledgePayload(checkpoint.payload)!==checkpoint.outputHash||inputManifest.outputHash!==checkpoint.outputHash||inputManifest.inputHash!==checkpoint.inputHash||!isDeepStrictEqual(inputManifest.evidence,checkpoint.evidence)||!isDeepStrictEqual(inputManifest.dependencies,checkpoint.dependencies)||!isDeepStrictEqual([original.markdown,original.sources],[body?.markdown,body?.sources]))throw new Error('OUTPUT_HASH_MISMATCH');}const evidence=inputManifest?.evidence;const observedRanges=Array.isArray(evidence)?evidence.filter((e:any)=>e?.kind==='read'&&typeof e.path==='string'&&prepared.source.files[e.path]?.hash===e.hash&&Number.isInteger(e.startLine)&&Number.isInteger(e.endLine)).map((e:any)=>({path:e.path,start:e.startLine,end:e.endLine})):undefined;const context={pageId:def.id,pageIds:[...expected]};if(observedRanges)validateStageResult({phase:'overview',files:prepared.source.files,observedRanges},{summary:'source check',sources:original.sources});const artifact=(observedRanges?normalizeStageSources('generate',original,prepared.source.files,observedRanges,context):normalizeWikiNavigation(original,prepared.source.files,context)) as Artifact;publicationBodies[def.id]=artifact.markdown;if(!artifact.markdown.trim()||!artifact.sources.length)throw new Error('INVALID_ARTIFACT');validateStageResult({phase:'generate',files:prepared.source.files,...context,observedRanges},artifact);const id=storedId(def.id);const legacy=input.key.domain==='cards'&&(!def.id.startsWith('cards/')||pages[def.id]?.inputManifest?.logicalId===def.id)?pages[def.id]:undefined;if(legacy&&id!==def.id&&pages[id])throw new Error('DUPLICATE_CARD_ID');const old=pages[id]??legacy;if(legacy&&id!==def.id&&!pages[id])delete pages[def.id];let [markdown,conflict]=old?three_way_merge(old.baseline??'',old.markdown,artifact.markdown):[artifact.markdown,false];if(old?.status==='conflict'&&old.pending_markdown!==artifact.markdown){markdown=old.markdown;conflict=true;}
   const sources=artifact.sources.map(s=>({path:s.path,start_line:s.start,end_line:s.end}));const manifest=artifact.inputManifest&&typeof artifact.inputManifest==='object'&&!Array.isArray(artifact.inputManifest)?artifact.inputManifest:{};const publicationManifest={...manifest,...(artifact.navigationWarnings?{navigationWarnings:artifact.navigationWarnings}:{}),...(artifact.navigationWarnings||artifact.markdown!==original.markdown?{normalizedBodyHash:hashKnowledgePayload(artifact.markdown)}:{})};pages[id]={id,kind:input.key.domain==='cards'?'card':'wiki',...(input.key.domain==='cards'?{category:'源码知识'}:{}),title:def.title,goal:def.goal,markdown,baseline:conflict&&old?old.baseline??'':artifact.markdown,pending_markdown:conflict?artifact.markdown:null,status:conflict?'conflict':markdown!==artifact.markdown?'edited':'ready',revision:++revision,sources:conflict&&old?old.sources??[]:sources,pending_sources:conflict?sources:null,dependencies:input.key.domain==='cards'?def.dependencies.map(storedId):def.dependencies,direct_sources:sources,related_page_hashes:{},identity:prepared.source.identity,updated_at:new Date().toISOString(),inputManifest:input.key.domain==='cards'?{...publicationManifest,logicalId:def.id}:Object.keys(publicationManifest).length?publicationManifest:null};
  }
  for(const [id,page] of Object.entries(pages))if(!expectedStored.has(id)&&page.status!=='archived'){page.status='archived';page.revision=++revision;page.updated_at=new Date().toISOString();}
  facts.project.next_revision=revision;facts.pages[ns]=pages;facts.snapshots[ns]={hashes:prepared.source.hashes,edges:prepared.source.edges,identity:prepared.source.identity,definitions:input.definitions,coverage:{partial:false},target:input.key.domain,updated_at:new Date().toISOString(),kernelBaseline:{sourceSnapshot:prepared.source,definitions:input.definitions,pipelineConfigHash:input.pipelineConfigHash,planHash:input.planHash,planToken:input.planToken,modelIdentity:input.modelIdentity,checkpoints:(input.checkpoints??[]).filter(item=>item.phase!=='generate'),graph:input.graph??null}};
  const candidateId=randomUUID();const intentHash=hash([input.taskId,input.publicationId,input.key,input.sourceSnapshot.sourceHash,input.planHash,input.pipelineConfigHash,input.definitions,input.artifacts,publicationBodies,...(input.pipelineConfigHash==='knowledge-kernel-qoder-v2'?[input.executionPolicy,input.runMaxItems,input.checkpoints?.find(item=>item.phase==='validate')?.payload]:[])]);const fake:ProjectPublicationClaim={version:1,taskId:input.taskId,claimId:'pending',publicationId:input.publicationId,namespace:ns,fence:input.fence,intentHash,outputSetHash:'pending'};const outputSetHash=files.publicationOutputHash(facts,fake);
  this.candidates.set(candidateId,{input,facts,files,namespace:ns,intentHash,outputSetHash,planToken:prepared.planToken,root:prepared.root});return {candidateId,intentHash,outputSetHash,namespace:ns};
 }
 private validateV2Publication(input:PublicationInput,prepared:Awaited<ReturnType<KnowledgeProjectPort['prepare']>>):void {
  if(!input.graph||!input.checkpoints)throw new Error('COMPLETION_MANIFEST_REQUIRED');const supplied=input.graph as StageGraph;
  const policy=knowledgeExecutionPolicySchema.parse(input.executionPolicy) as KnowledgeExecutionPolicyV2;
  if(!Number.isSafeInteger(input.runMaxItems)||input.runMaxItems!<1)throw new Error('INVALID_RUN_MAX_ITEMS');
  const graphInput={inputHash:hashKnowledgePayload([input.key,prepared.source.sourceHash,input.modelIdentity,input.planToken,input.pipelineConfigHash]),authorConstraints:JSON.stringify(prepared.plan),version:2 as const,maxCatalogueNodes:policy.maxCatalogueNodes,maxItems:input.runMaxItems};
  let graph=input.key.domain==='wiki'?buildWikiStageGraph(graphInput):buildCardStageGraph(graphInput);
  const artifacts:VerifiedArtifact[]=input.checkpoints.map(item=>({taskId:input.taskId,phase:item.phase,itemId:item.itemId,attempt:1,revision:0,inputHash:item.inputHash,outputHash:item.outputHash,payload:item.payload,evidence:item.evidence,dependencies:item.dependencies,state:'prepared'}));
  if(artifacts.some(item=>hashKnowledgePayload(item.payload)!==item.outputHash))throw new Error('OUTPUT_HASH_MISMATCH');
  const remaining=artifacts.filter(item=>item.phase!=='validate');let moved=true;while(moved&&remaining.length){moved=false;for(let i=0;i<remaining.length;i++){const item=remaining[i],node=graph.nodes.find(n=>n.id===item.itemId&&n.phase===item.phase);if(node&&node.inputHash===item.inputHash&&node.deps.every(dep=>graph.completed.includes(dep))){graph=advanceStageGraph(graph,node.id,item.payload as Record<string,unknown>);remaining.splice(i--,1);moved=true;}}}if(remaining.length)throw new Error('CHECKPOINT_INPUT_CHANGED');
  const snapshotId=`${input.taskId}:${hashKnowledgePayload(input.sourceSnapshot)}`;const requirements=requirementsFromGraph(graph,input.pipelineConfigHash,snapshotId,artifacts);
  const manifest=artifacts.find(item=>item.phase==='validate'&&item.itemId==='validate');if(!manifest)throw new Error('COMPLETION_MANIFEST_REQUIRED');validateCompletionManifest(manifest.payload as KnowledgeCompletionManifest,requirements,artifacts.filter(item=>item!==manifest));
  const expected=requirements.required.filter(item=>item.phase==='generate');if(expected.length!==input.definitions.length||expected.length!==Object.keys(input.artifacts).length)throw new Error('INCOMPLETE_PUBLICATION');
  for(const item of expected){const checkpoint=artifacts.find(a=>a.phase===item.phase&&a.itemId===item.itemId)!;const node=graph.nodes.find(n=>n.id===item.itemId)!;const id=node.definition?.id??'repository';const artifact=input.artifacts[id];const body=checkpoint.payload as Artifact;const definition=input.definitions.find(d=>d.id===id);const expectedDefinition=node.definition??{id:'repository',title:'Repository',goal:'Repository synthesis',dependencies:node.deps.filter(dep=>dep.startsWith('card:')).map(dep=>dep.slice(5))};if(!artifact||!definition||hashKnowledgePayload([artifact.markdown,artifact.sources])!==hashKnowledgePayload([body.markdown,body.sources])||hashKnowledgePayload([definition.id,definition.title,definition.goal,definition.dependencies])!==hashKnowledgePayload([expectedDefinition.id,expectedDefinition.title,expectedDefinition.goal,expectedDefinition.dependencies]))throw new Error('OUTPUT_HASH_MISMATCH');}
  const relations=artifacts.find(item=>item.phase==='relations');if(input.key.domain==='cards'){if(!relations)throw new Error('REQUIRED_ITEMS_INCOMPLETE');validateStageResult({phase:'relations',files:prepared.source.files,endpoints:graph.definitions.map(d=>d.id),relationTypes:['uses','contains','depends_on','calls'],observedRanges:relations.evidence.filter(e=>e.kind==='read'&&e.startLine!==undefined&&e.endLine!==undefined).map(e=>({path:e.path,start:e.startLine!,end:e.endLine!}))},relations.payload);}
  if(supplied.inputHash!==graph.inputHash||supplied.domain!==graph.domain||supplied.version!==2||supplied.maxCatalogueNodes!==policy.maxCatalogueNodes||supplied.maxItems!==input.runMaxItems)throw new Error('GRAPH_IDENTITY_MISMATCH');
 }
 async commitPublication(candidateId:string,claim:PublishClaim) {
  const c=this.candidates.get(candidateId);if(!c)throw new Error('UNKNOWN_PUBLICATION_CANDIDATE');if(claim.taskId!==c.input.taskId||claim.publicationId!==c.input.publicationId||claim.intentHash!==c.intentHash||claim.outputSetHash!==c.outputSetHash||hash(claim.fence)!==hash(c.input.fence))throw new Error('PUBLICATION_CLAIM_MISMATCH');
  const current=await this.prepare(c.input.key.projectId,c.input.key.domain);if(hash(current.key)!==hash(c.input.key)||current.planToken!==c.planToken||current.source.sourceHash!==c.input.sourceSnapshot.sourceHash||current.source.scopeHash!==c.input.sourceSnapshot.scopeHash)throw new Error('PUBLICATION_INPUT_CHANGED');
  if(c.input.pipelineConfigHash==='knowledge-kernel-qoder-v2')this.validateV2Publication(c.input,current);
  const fileClaim:ProjectPublicationClaim={...claim,namespace:c.namespace};c.files.bindPublicationClaim(fileClaim);const receipt=c.files.commitPublication(c.facts,fileClaim);this.candidates.delete(candidateId);return receipt;
 }
 reconcile(projectId:string,domain:Domain,claim:PublishClaim) {
  const meta=this.read(projectId,domain);const files=new ProjectFiles(meta.root,meta.language);
  // Both reads recover a prepared journal before inspecting durable state.
  const receipt=files.readPublicationReceipt();const guard=files.readExecutionGuard();
  if(receipt&&receipt.taskId===claim.taskId&&receipt.claimId===claim.claimId&&receipt.publicationId===claim.publicationId&&receipt.ledgerId===claim.fence.ledgerId&&receipt.generation===claim.fence.generation&&receipt.intentHash===claim.intentHash&&receipt.outputSetHash===claim.outputSetHash&&receipt.namespace===meta.namespace)return {status:'matching' as const,receipt};
  const current=guard&&guard.scopeIdentity===meta.scope&&guard.taskId===claim.taskId&&guard.ledgerId===claim.fence.ledgerId&&guard.controllerEpoch===claim.fence.controllerEpoch&&guard.ownerId===claim.fence.ownerId&&guard.generation===claim.fence.generation;
  const unbound=guard&&!guard.claimId&&!guard.publicationId&&!guard.intentHash&&!guard.outputSetHash;
  const bound=guard&&guard.claimId===claim.claimId&&guard.publicationId===claim.publicationId&&guard.intentHash===claim.intentHash&&guard.outputSetHash===claim.outputSetHash;
  const olderReceipt=!receipt||(receipt.ledgerId===claim.fence.ledgerId&&receipt.generation<claim.fence.generation);
  return current&&(unbound||bound)&&olderReceipt?{status:'not_prepared' as const}:{status:'conflict' as const};
 }
 refreshIndex(projectId:string):void {const project=this.engine.get_project(projectId);this.engine.refreshKnowledgeProject(projectId,{branch:branch(project.path),language:project.language});}
}






