import { createHash } from 'node:crypto';

export type Phase = 'prepare' | 'readme' | 'overview' | 'plan' | 'catalogue' | 'generate' | 'relations' | 'validate';
export interface Definition { id: string; title: string; goal: string; dependencies: string[]; expand?: boolean }
export interface StageNode { id: string; phase: Phase; kind: string; deps: string[]; inputHash: string; definition?: Definition; depth?: number }
export interface StageGraph { version?: 2; maxCatalogueNodes?: number; maxItems?: number; domain: 'wiki' | 'cards'; inputHash: string; authorConstraints?: string; nodes: StageNode[]; completed: string[]; total: number | null; definitions: Definition[]; expanded: string[]; leaves: string[]; outputHashes: Record<string,string> }
export interface GraphInput { inputHash: string; authorConstraints?: string; version?: 2; maxCatalogueNodes?: number; maxItems?: number }
/** Match the existing wiki_plan slug contract, including nested logical IDs. */
export function isKnowledgeId(value:unknown):value is string {
 return typeof value==='string' && value.length<=500 && /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value);
}
const digest = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const canonical = (value:unknown):unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
const node = (id: string, phase: Phase, deps: string[], graph: Pick<StageGraph,'inputHash'|'authorConstraints'>, extra: Partial<StageNode> = {}): StageNode => ({id,phase,kind:phase,deps,inputHash:digest([graph.inputHash,graph.authorConstraints,id,extra.definition]),...extra});
export function buildWikiStageGraph(input: GraphInput): StageGraph {
 const graph: StageGraph = {domain:'wiki',...input,nodes:[],completed:[],total:null,definitions:[],expanded:[],leaves:[],outputHashes:{}};
 graph.nodes.push(node('prepare','prepare',[],graph),...(input.version===2?[node('readme','readme',['prepare'],graph)]:[]),node('overview','overview',[input.version===2?'readme':'prepare'],graph),node('plan','plan',['overview'],graph)); for(const n of graph.nodes) if(!graph.completed.includes(n.id)) n.inputHash=digest([graph.inputHash,graph.authorConstraints,n.id,n.definition,n.deps.map(d=>graph.outputHashes[d]??null)]);
 return graph;
}
export function selectReadyItems(graph: StageGraph, checkpoints: string[]): StageNode[] {
 const done = new Set([...graph.completed,...checkpoints]);
 return graph.nodes.filter(n=>!done.has(n.id) && n.deps.every(d=>done.has(d)));
}
function definitions(value: unknown): Definition[] {
 if (!Array.isArray(value) || !value.length) throw new Error('INVALID_PLAN');
 return value.map(x=>{if (!x || typeof x !== 'object') throw new Error('INVALID_PLAN'); const d=x as Definition;
  if (!isKnowledgeId(d.id) || typeof d.title!=='string' || !d.title.trim() || typeof d.goal!=='string' || !d.goal.trim() || !Array.isArray(d.dependencies) || d.dependencies.some(v=>!isKnowledgeId(v))) throw new Error('INVALID_PLAN'); return {...d,dependencies:[...d.dependencies]};});
}
function validateDefinitions(items: Definition[], allowMissing = false): void {
 const ids=new Set<string>(), titles=new Set<string>(); for(const d of items){const title=d.title.trim().toLocaleLowerCase();if(ids.has(d.id)||titles.has(title)) throw new Error('DUPLICATE_DEFINITION');ids.add(d.id);titles.add(title);}
 const byId=new Map(items.map(d=>[d.id,d])); const visiting=new Set<string>(), visited=new Set<string>();
 const visit=(id:string):void=>{if(visiting.has(id)) throw new Error('DEPENDENCY_CYCLE');if(visited.has(id)) return;const d=byId.get(id);if(!d){if(!allowMissing)throw new Error('MISSING_DEPENDENCY');return;}visiting.add(id);d.dependencies.forEach(visit);visiting.delete(id);visited.add(id);};items.forEach(d=>visit(d.id));
}
/** A structural ancestor is not a page prerequisite; use its own prerequisites instead. */
function leafDependencies(definition:Definition,byId:Map<string,Definition>,descendants:(id:string)=>string[]):string[] {
 const resolve=(dep:string):string[]=>{
  if(definition.id.startsWith(`${dep}/`)) {const ancestor=byId.get(dep);if(!ancestor)throw new Error('MISSING_DEPENDENCY');return ancestor.dependencies.flatMap(resolve);}
  const leaves=descendants(dep);if(!leaves.length)throw new Error('MISSING_DEPENDENCY');return leaves;
 };
 return [...new Set(definition.dependencies.flatMap(resolve))];
}
/** Advance only after the caller has validated and durably acknowledged the item. */
export function advanceStageGraph(original: StageGraph, id: string, payload: Record<string, unknown>): StageGraph {
 const graph=structuredClone(original); const current=graph.nodes.find(n=>n.id===id);if(!current)throw new Error('UNKNOWN_STAGE_ITEM');
 if(graph.completed.includes(id)){if(graph.outputHashes[id]!==digest(payload))throw new Error('CONFLICTING_CHECKPOINT');return graph;}
 if(!current.deps.every(d=>graph.completed.includes(d)))throw new Error('STAGE_NOT_READY');
 if(graph.version===2 && graph.domain==='wiki') return advanceWikiV2(graph,current,payload);
 graph.completed.push(id); graph.outputHashes[id]=digest(payload);
 if(id==='plan'){
  const items=definitions(payload?.items);validateDefinitions(items); if(graph.domain==='cards'&&items.some(item=>item.id==='repository'))throw new Error('DUPLICATE_DEFINITION');if(items.length+(graph.domain==='cards'?1:0)>500)throw new Error('CATALOGUE_LIMIT');graph.definitions=items;
  if(graph.domain==='wiki') graph.nodes.push(...items.map(d=>node(`catalogue:${d.id}`,'catalogue',['plan'],graph,{definition:d,depth:1})));
  else {graph.total=items.length+1; graph.nodes.push(...items.map(d=>node(`card:${d.id}`,'generate',['plan',...d.dependencies.map(x=>`card:${x}`)],graph,{definition:d,kind:'module-card'})));graph.nodes.push(node('card:repository','generate',items.map(d=>`card:${d.id}`),graph,{kind:'repository-card'}),node('relations','relations',['card:repository'],graph),node('validate','validate',['relations'],graph));}
 }
 if(current.phase==='catalogue'){
  const children=payload?.children;if(!Array.isArray(children))throw new Error('INVALID_CATALOGUE');
  const rawItems=children.length?definitions(children):[];const parent=current.definition!;
  const ids=new Map(rawItems.map(item=>[item.id,item.id.startsWith(`${parent.id}/`)?item.id:`${parent.id}/${item.id}`]));
  const newItems=rawItems.map(item=>({...item,id:ids.get(item.id)!,dependencies:[...new Set([...parent.dependencies,...item.dependencies.map(dep=>ids.get(dep)??dep)])]}));const depth=(current.depth??0)+1;
  if(newItems.some(item=>!isKnowledgeId(item.id)))throw new Error('INVALID_CATALOGUE');
  if(newItems.length && depth>6 || graph.definitions.length+newItems.length>500)throw new Error('CATALOGUE_LIMIT');
  graph.definitions.push(...newItems);validateDefinitions(graph.definitions,true);graph.expanded.push(id);
  if(!newItems.length)graph.leaves.push(current.definition!.id);
  graph.nodes.push(...newItems.map(d=>node(`catalogue:${d.id}`,'catalogue',[id],graph,{definition:d,depth})));
  if(graph.nodes.filter(n=>n.phase==='catalogue').every(n=>graph.completed.includes(n.id))){
   const descendants=(id:string):string[]=>{if(graph.leaves.includes(id))return [id];const children=graph.nodes.filter(n=>n.phase==='catalogue'&&n.deps.includes(`catalogue:${id}`));if(!children.length)throw new Error('MISSING_DEPENDENCY');return children.flatMap(child=>descendants(child.definition!.id));};
   validateDefinitions(graph.definitions);const byId=new Map(graph.definitions.map(d=>[d.id,d]));
   const leafDefs=graph.definitions.filter(d=>graph.leaves.includes(d.id)).map(d=>({...d,dependencies:leafDependencies(d,byId,descendants)}));validateDefinitions(leafDefs);graph.total=leafDefs.length;
   graph.nodes.push(...leafDefs.map(d=>node(`generate:${d.id}`,'generate',[`catalogue:${d.id}`,...d.dependencies.map(x=>`generate:${x}`)],graph,{definition:d,kind:'page'})));
   graph.nodes.push(node('validate','validate',leafDefs.map(d=>`generate:${d.id}`),graph));
  }
 }
 for(const n of graph.nodes) if(!graph.completed.includes(n.id)) n.inputHash=digest([graph.inputHash,graph.authorConstraints,n.id,n.definition,n.deps.map(d=>graph.outputHashes[d]??null)]);
 return graph;
}




export interface CatalogueArtifact { tree: Definition[]; pages: Definition[]; requiredPageIds: string[]; catalogueHash: string }
export function buildCatalogueArtifact(graph: StageGraph): CatalogueArtifact {
 if(graph.version!==2 || !graph.nodes.some(n=>n.id==='catalogue:complete') || graph.nodes.some(n=>n.phase==='catalogue' && n.id!=='catalogue:complete' && !graph.completed.includes(n.id))) throw new Error('CATALOGUE_INCOMPLETE');
 const tree=[...graph.definitions].sort((a,b)=>a.id.localeCompare(b.id));
 const descendants=(id:string):string[]=>graph.leaves.includes(id)?[id]:graph.leaves.filter(leaf=>leaf.startsWith(`${id}/`)).sort();
 validateDefinitions(tree);const byId=new Map(tree.map(d=>[d.id,d]));
 const pages=tree.filter(d=>graph.leaves.includes(d.id)).map(d=>({...d,dependencies:leafDependencies(d,byId,descendants).sort()}));
 validateDefinitions(pages);
 const requiredPageIds=pages.map(page=>page.id);const catalogueHash=digest(canonical({tree,pages,requiredPageIds}));return {tree,pages,requiredPageIds,catalogueHash};
}
function advanceWikiV2(graph:StageGraph,current:StageNode,payload:Record<string,unknown>):StageGraph {
 const id=current.id;graph.completed.push(id);graph.outputHashes[id]=digest(payload);
 if(id==='plan') { const items=definitions(payload.items);validateDefinitions(items);graph.nodes.push(node('catalogue:root','catalogue',['plan'],graph,{depth:0})); }
 else if(current.phase==='catalogue' && id!=='catalogue:complete') {
  if(!Array.isArray(payload.children))throw new Error('INVALID_CATALOGUE');
  const children=payload.children.length?definitions(payload.children):[];const parent=current.definition;
  if(!parent && !children.length)throw new Error('INVALID_CATALOGUE');
  const names=new Map(children.map(d=>[d.id,parent && !d.id.startsWith(`${parent.id}/`)?`${parent.id}/${d.id}`:d.id]));
  const entries=children.map(d=>({...d,id:names.get(d.id)!,dependencies:[...new Set([...(parent?.dependencies??[]),...d.dependencies.map(dep=>names.get(dep)??dep)])]}));
  const depth=(current.depth??0)+1;
  if(entries.length && depth>6 || entries.some(d=>d.id.split('/').length>6))throw new Error('CATALOGUE_LIMIT');
  if(graph.definitions.length+entries.length>(graph.maxItems??500))throw new Error('CATALOGUE_LIMIT');
  graph.definitions.push(...entries);validateDefinitions(graph.definitions,true);graph.expanded.push(id);
  if(!entries.length && parent)graph.leaves.push(parent.id);
  for(const d of entries) { if(d.expand===false)graph.leaves.push(d.id);else graph.nodes.push(node(`catalogue:item:${d.id}`,'catalogue',[id],graph,{definition:d,depth})); }
  if(graph.nodes.filter(n=>n.phase==='catalogue').length>(graph.maxCatalogueNodes??64))throw new Error('CATALOGUE_LIMIT');
  graph.definitions.sort((a,b)=>a.id.localeCompare(b.id));graph.leaves.sort();graph.expanded.sort();
  graph.nodes.sort((a,b)=>a.phase==='catalogue'&&b.phase==='catalogue' ? (a.depth??0)-(b.depth??0)||a.id.localeCompare(b.id) : 0);
  if(graph.nodes.filter(n=>n.phase==='catalogue').every(n=>graph.completed.includes(n.id)))graph.nodes.push(node('catalogue:complete','catalogue',graph.nodes.filter(n=>n.phase==='catalogue').map(n=>n.id).sort(),graph));
 }
 else if(id==='catalogue:complete') {
  const expected=buildCatalogueArtifact(graph);if(digest(expected)!==digest(payload))throw new Error('CATALOGUE_MISMATCH');
  graph.total=expected.pages.length;
  graph.nodes.push(...expected.pages.map(d=>node(`generate:${d.id}`,'generate',['catalogue:complete',...d.dependencies.map(dep=>`generate:${dep}`)],graph,{definition:d,kind:'page'})));
  graph.nodes.push(node('validate','validate',expected.pages.map(d=>`generate:${d.id}`),graph));
 }
 for(const n of graph.nodes)if(!graph.completed.includes(n.id))n.inputHash=digest([graph.inputHash,graph.authorConstraints,n.id,n.definition,n.deps.map(d=>graph.outputHashes[d]??null)]);
 return graph;
}
