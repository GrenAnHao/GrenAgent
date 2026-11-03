import { describe, it, expect } from 'vitest';
import { buildWikiStageGraph, advanceStageGraph, selectReadyItems, buildCatalogueArtifact } from './pipeline';
import { validateStageResult } from './validation';
describe('wiki graph', () => {
 it('expands catalogue and freezes the actual total', () => {
  let g = buildWikiStageGraph({ inputHash:'snapshot', authorConstraints:'focus modules' });
  expect(g.total).toBeNull(); expect(selectReadyItems(g,[]).map(n=>n.id)).toEqual(['prepare']);
  g=advanceStageGraph(g,'prepare',{}); g=advanceStageGraph(g,'overview',{});
  g=advanceStageGraph(g,'plan',{items:[{id:'api',title:'API',goal:'Explain API',dependencies:[]}]});
  g=advanceStageGraph(g,'catalogue:api',{children:[{id:'routes',title:'Routes',goal:'Explain routes',dependencies:[]}]});
  g=advanceStageGraph(g,'catalogue:api/routes',{children:[]});
  expect(g.total).toBe(1); expect(g.nodes.find(n=>n.id==='generate:api/routes')).toBeDefined();
 });
 it('rejects cycles and invalid evidence',()=>{
  let g=buildWikiStageGraph({inputHash:'s'}); g=advanceStageGraph(g,'prepare',{}); g=advanceStageGraph(g,'overview',{});
  expect(()=>advanceStageGraph(g,'plan',{items:[{id:'a',title:'A',goal:'a',dependencies:['b']},{id:'b',title:'B',goal:'b',dependencies:['a']}]})).toThrow();
  expect(()=>validateStageResult({phase:'generate',files:{'a.ts':{hash:'h',lines:2}}},{markdown:'x',sources:[{path:'a.ts',hash:'h',start:1,end:3}]})).toThrow();
 });
});

it('rejects incomplete plan, empty overview and unverifiable relations',()=>{
 expect(()=>validateStageResult({phase:'plan'},{items:[]})).toThrow();
 expect(()=>validateStageResult({phase:'overview'},{summary:''})).toThrow();
 expect(()=>validateStageResult({phase:'relations',endpoints:['a','b'],relationTypes:['uses'],files:{'a.ts':{hash:'h',lines:1}}},{relations:[{from:'a',to:'b',type:'uses',sources:[{path:'a.ts',hash:'wrong',start:1,end:1}]}]})).toThrow();
});

it('replays acknowledged outputs and binds dependent inputs to output hashes',()=>{
 const replay=(summary:string)=>{let g=buildWikiStageGraph({inputHash:'s'});g=advanceStageGraph(g,'prepare',{snapshotId:'x'});g=advanceStageGraph(g,'overview',{summary});return g;};
 expect(replay('one')).toEqual(replay('one'));
 expect(replay('one').nodes.find(n=>n.id==='plan')?.inputHash).not.toBe(replay('two').nodes.find(n=>n.id==='plan')?.inputHash);
});

it('rejects links to pages outside the frozen catalogue',()=>{
 const req={phase:'generate' as const,files:{'a.ts':{hash:'h',lines:1}},pageIds:['known']};
 expect(()=>validateStageResult(req,{markdown:'[missing](missing.md)',sources:[{path:'a.ts',hash:'h',start:1,end:1}]})).toThrow();
});

it('rejects conflicting replays and leaves independent items ready after a failure',()=>{
 let g=buildWikiStageGraph({inputHash:'s'});g=advanceStageGraph(g,'prepare',{snapshotId:'x'});
 expect(()=>advanceStageGraph(g,'prepare',{snapshotId:'different'})).toThrow();
 g=advanceStageGraph(g,'overview',{});g=advanceStageGraph(g,'plan',{items:[{id:'a',title:'A',goal:'a',dependencies:[]},{id:'b',title:'B',goal:'b',dependencies:[]}]});
 g=advanceStageGraph(g,'catalogue:a',{children:[]});g=advanceStageGraph(g,'catalogue:b',{children:[]});
 expect(selectReadyItems(g,[]).map(n=>n.id)).toEqual(['generate:a','generate:b']);
 g=advanceStageGraph(g,'generate:b',{markdown:'B'});expect(selectReadyItems(g,[]).map(n=>n.id)).toEqual(['generate:a']);
});

it('requires cited source to have been observed by the tool session',()=>{
 const req={phase:'generate' as const,files:{'a.ts':{hash:'h',lines:1}},observedFiles:[] as string[]};
 expect(()=>validateStageResult(req,{markdown:'content',sources:[{path:'a.ts',hash:'h',start:1,end:1}]})).toThrow();
});

it('rejects citations outside observed line ranges',()=>{
 const req={phase:'generate' as const,files:{'a.ts':{hash:'h',lines:30}},observedFiles:['a.ts'],observedRanges:[{path:'a.ts',start:1,end:5}]};
 expect(()=>validateStageResult(req,{markdown:'content',sources:[{path:'a.ts',hash:'h',start:6,end:7}]})).toThrow();
});

it('rejects missing definition IDs instead of coercing them to strings',()=>{
 let g=buildWikiStageGraph({inputHash:'s'});g=advanceStageGraph(g,'prepare',{});g=advanceStageGraph(g,'overview',{});
 expect(()=>advanceStageGraph(g,'plan',{items:[{title:'A',goal:'a',dependencies:[]}]})).toThrow();
});
it('rejects inline source citations beyond the observed evidence',()=>{
 const req={phase:'generate' as const,files:{'a.ts':{hash:'h',lines:10}},observedRanges:[{path:'a.ts',start:1,end:3}]};
 expect(()=>validateStageResult(req,{markdown:'[ref](source:a.ts#L1-L9)',sources:[{path:'a.ts',hash:'h',start:1,end:2}]})).toThrow();
});
it('keeps authored nested IDs and resolves dependencies on expanded catalogue groups',()=>{
 let g=buildWikiStageGraph({inputHash:'s',authorConstraints:'modules/api'});g=advanceStageGraph(g,'prepare',{});g=advanceStageGraph(g,'overview',{});
 const items=[{id:'modules/api',title:'API',goal:'API',dependencies:[]},{id:'client',title:'Client',goal:'Client',dependencies:['modules/api']}];
 expect(()=>validateStageResult({phase:'plan'},{items})).not.toThrow();g=advanceStageGraph(g,'plan',{items});
 g=advanceStageGraph(g,'catalogue:modules/api',{children:[{id:'routes',title:'Routes',goal:'Routes',dependencies:[]},{id:'types',title:'Types',goal:'Types',dependencies:['routes']}]});
 g=advanceStageGraph(g,'catalogue:client',{children:[]});g=advanceStageGraph(g,'catalogue:modules/api/routes',{children:[]});g=advanceStageGraph(g,'catalogue:modules/api/types',{children:[]});
 expect(g.nodes.find(n=>n.id==='generate:client')?.deps).toEqual(expect.arrayContaining(['generate:modules/api/routes','generate:modules/api/types']));expect(g.nodes.find(n=>n.id==='generate:modules/api/types')?.deps).toContain('generate:modules/api/routes');
 expect(g.nodes.filter(n=>n.phase==='generate').map(n=>n.definition?.id)).toEqual(expect.arrayContaining(['modules/api/routes','modules/api/types','client']));
});


it('accepts links relative to nested pages and rejects unsafe slugs',()=>{const files={'a.ts':{hash:'h',lines:1}};expect(()=>validateStageResult({phase:'generate',files,pageId:'modules/api/routes',pageIds:['modules/api/types']},{markdown:'[Types](types.md)',sources:[{path:'a.ts',hash:'h',start:1,end:1}]})).not.toThrow();for(const id of ['../bad','a//b','/absolute','a/..'])expect(()=>validateStageResult({phase:'plan'},{items:[{id,title:'Bad',goal:'Bad',dependencies:[]}]})).toThrow();});

it('validates source citations to Markdown files as sources rather than page links',()=>{
 const files={'README.md':{hash:'h',lines:1}};const payload={markdown:'[Source](source:README.md#L1)\n[Docs](https://example.com/guide.md)',sources:[{path:'README.md',hash:'h',start:1,end:1}]};expect(()=>validateStageResult({phase:'generate',files,pageId:'repository',pageIds:['repository']},payload)).not.toThrow();
});

it('v2 freezes the complete catalogue before scheduling pages, independent of expansion order', async () => {
 const { buildCatalogueArtifact } = await import('./pipeline');
 const advance = (order: string[]) => {
  let g = buildWikiStageGraph({inputHash:'s', version:2} as any);
  g=advanceStageGraph(g,'prepare',{});g=advanceStageGraph(g,'readme',{present:false,excerpts:[],truncated:false});g=advanceStageGraph(g,'overview',{});
  g=advanceStageGraph(g,'plan',{items:[{id:'a',title:'A',goal:'A',dependencies:[]}]});
  g=advanceStageGraph(g,'catalogue:root',{children:[{id:'a',title:'A',goal:'A',dependencies:[]},{id:'b',title:'B',goal:'B',dependencies:[]}]});
  for (const id of order) g=advanceStageGraph(g,`catalogue:item:${id}`,{children: id==='a' ? [{id:'sub',title:'Sub',goal:'Sub',dependencies:[],expand:false}] : []});
  expect(selectReadyItems(g,[]).map(n=>n.id)).toEqual(['catalogue:complete']);
  const artifact=buildCatalogueArtifact(g);g=advanceStageGraph(g,'catalogue:complete',artifact as any);
  return {artifact, definitions:g.definitions, expanded:g.expanded, leaves:g.leaves, pageIds: g.nodes.filter(n=>n.phase==='generate').map(n=>n.id)};
 };
 const first=advance(['a','b']), second=advance(['b','a']);
 expect(first).toEqual(second); expect(first.pageIds).toEqual(['generate:a/sub','generate:b']);
});

it('v2 rejects catalogue overflow, duplicate IDs and excessive depth rather than making implicit leaves', () => {
 const base=()=>{let g=buildWikiStageGraph({inputHash:'s',version:2});for(const [id,payload] of [['prepare',{}],['readme',{}],['overview',{}],['plan',{items:[{id:'x',title:'X',goal:'X',dependencies:[]}]}]] as const)g=advanceStageGraph(g,id,payload);return g;};
 const defs=(count:number)=>Array.from({length:count},(_,i)=>({id:`n${i}`,title:`N${i}`,goal:'x',dependencies:[]}));
 expect(()=>advanceStageGraph(base(),'catalogue:root',{children:defs(64)})).toThrow('CATALOGUE_LIMIT');
 expect(()=>advanceStageGraph(base(),'catalogue:root',{children:[...defs(1),...defs(1)]})).toThrow();
 let g=advanceStageGraph(base(),'catalogue:root',{children:[{id:'a',title:'A',goal:'A',dependencies:[]}]});
 for(const id of ['a','a/b','a/b/b','a/b/b/b','a/b/b/b/b'])g=advanceStageGraph(g,`catalogue:item:${id}`,{children:[{id:'b',title:`${id} child`,goal:'x',dependencies:[]}]});
 expect(()=>advanceStageGraph(g,'catalogue:item:a/b/b/b/b/b',{children:[{id:'b',title:'Too deep',goal:'x',dependencies:[]}]})).toThrow('CATALOGUE_LIMIT');
});

it('tells a catalogue root to emit the initial tree rather than an empty leaf',async()=>{
 const {stagePrompt}=await import('../../knowledgeProcess/pipelinePrompts');const prompt=stagePrompt({id:'catalogue:root',phase:'catalogue',kind:'catalogue',deps:[],inputHash:'x',depth:0},{snapshotId:'s',files:{},dependencies:{}});const user=JSON.parse(prompt.user);expect(user.itemId).toBe('catalogue:root');expect(user.instructions).toContain('root');expect(user.instructions).toContain('expand');
});

it('applies the catalogue node limit frozen with the task',()=>{
 let g=buildWikiStageGraph({inputHash:'s',version:2,maxCatalogueNodes:2} as any);for(const [id,payload] of [['prepare',{}],['readme',{}],['overview',{}],['plan',{items:[{id:'a',title:'A',goal:'A',dependencies:[]}]}]] as const)g=advanceStageGraph(g,id,payload);
 expect(()=>advanceStageGraph(g,'catalogue:root',{children:[{id:'a',title:'A',goal:'A',dependencies:[]},{id:'b',title:'B',goal:'B',dependencies:[]}]})).toThrow('CATALOGUE_LIMIT');
});

it('keeps the v2 catalogue hash stable after canonical JSON reorders object keys',async()=>{
 const {buildCatalogueArtifact}=await import('./pipeline');let g=buildWikiStageGraph({inputHash:'s',version:2});for(const [id,payload] of [['prepare',{}],['readme',{}],['overview',{}],['plan',{items:[{id:'a',title:'A',goal:'A',dependencies:[]}]}],['catalogue:root',{children:[{id:'a',title:'A',goal:'A',dependencies:[],expand:false}]}]] as const)g=advanceStageGraph(g,id,payload);
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
 expect(buildCatalogueArtifact(canonical(g)).catalogueHash).toBe(buildCatalogueArtifact(g).catalogueHash);
});

it('v2 enforces the frozen planned-item limit before the catalogue barrier',()=>{
 const base=()=>{let g=buildWikiStageGraph({inputHash:'s',version:2,maxItems:500});for(const [id,payload] of [['prepare',{}],['readme',{}],['overview',{}],['plan',{items:[{id:'seed',title:'Seed',goal:'Seed',dependencies:[]}]}]] as const)g=advanceStageGraph(g,id,payload);return g;};
 const leaves=(count:number,prefix:string)=>Array.from({length:count},(_,i)=>({id:`${prefix}${i}`,title:`${prefix} ${i}`,goal:'x',dependencies:[],expand:false}));
 const exact=advanceStageGraph(base(),'catalogue:root',{children:leaves(500,'root')});expect(exact.definitions).toHaveLength(500);expect(selectReadyItems(exact,[]).map(n=>n.id)).toEqual(['catalogue:complete']);
 const rootOver=base();expect(()=>advanceStageGraph(rootOver,'catalogue:root',{children:leaves(501,'root')})).toThrow('CATALOGUE_LIMIT');expect(rootOver.nodes.some(n=>n.id==='catalogue:complete'||n.phase==='generate')).toBe(false);
 let limited=buildWikiStageGraph({inputHash:'s',version:2,maxItems:2});for(const [id,payload] of [['prepare',{}],['readme',{}],['overview',{}],['plan',{items:[{id:'seed',title:'Seed',goal:'Seed',dependencies:[]}]}]] as const)limited=advanceStageGraph(limited,id,payload);expect(()=>advanceStageGraph(limited,'catalogue:root',{children:leaves(3,'small')})).toThrow('CATALOGUE_LIMIT');
 let nested=advanceStageGraph(base(),'catalogue:root',{children:[{id:'group',title:'Group',goal:'x',dependencies:[]},...leaves(498,'root')]});
 nested=advanceStageGraph(nested,'catalogue:item:group',{children:leaves(1,'leaf')});expect(nested.definitions).toHaveLength(500);expect(selectReadyItems(nested,[]).map(n=>n.id)).toEqual(['catalogue:complete']);
 let over=advanceStageGraph(base(),'catalogue:root',{children:[{id:'group',title:'Group',goal:'x',dependencies:[]},...leaves(499,'root')]});
 expect(()=>advanceStageGraph(over,'catalogue:item:group',{children:leaves(1,'leaf')})).toThrow('CATALOGUE_LIMIT');expect(over.nodes.some(n=>n.phase==='generate')).toBe(false);expect(selectReadyItems(over,[]).map(n=>n.id)).toEqual(['catalogue:item:group']);
});

it('v2 separates legal root and complete logical IDs from catalogue control nodes',()=>{
 let g=buildWikiStageGraph({inputHash:'s',version:2});for(const [id,payload] of [['prepare',{}],['readme',{}],['overview',{}],['plan',{items:[{id:'root',title:'Root',goal:'Root',dependencies:[]}]}]] as const)g=advanceStageGraph(g,id,payload);
 g=advanceStageGraph(g,'catalogue:root',{children:[{id:'root',title:'Root',goal:'Root',dependencies:[]},{id:'complete',title:'Complete',goal:'Complete',dependencies:[]},{id:'normal/nested',title:'Nested',goal:'Nested',dependencies:[]}]});
 expect(selectReadyItems(g,[]).map(n=>n.id)).toEqual(['catalogue:item:complete','catalogue:item:normal/nested','catalogue:item:root']);
 for(const id of ['complete','normal/nested','root']){g=advanceStageGraph(g,`catalogue:item:${id}`,{children:[]});if(id!=='root')expect(g.nodes.some(n=>n.id==='catalogue:complete')).toBe(false);}
 expect(selectReadyItems(g,[]).map(n=>n.id)).toEqual(['catalogue:complete']);const artifact=buildCatalogueArtifact(g);g=advanceStageGraph(g,'catalogue:complete',artifact as any);expect(g.nodes.filter(n=>n.phase==='generate').map(n=>n.id)).toEqual(['generate:complete','generate:normal/nested','generate:root']);
});

it.each([1,2])('v%i resolves a leaf structural-ancestor dependency to external prerequisites, not siblings',version=>{
 const def=(id:string,dependencies:string[]=[],expand?:boolean)=>({id,title:id,goal:id,dependencies,...(expand===undefined?{}:{expand})});
 let g=buildWikiStageGraph({inputHash:'s',...(version===2?{version:2 as const}:{})});
 g=advanceStageGraph(g,'prepare',{});if(version===2)g=advanceStageGraph(g,'readme',{});g=advanceStageGraph(g,'overview',{});
 const roots=[def('architecture'),def('modules/notes',['architecture']),def('outside',['modules/notes'])];g=advanceStageGraph(g,'plan',{items:roots});
 if(version===2)g=advanceStageGraph(g,'catalogue:root',{children:roots});
 const id=(value:string)=>version===2?`catalogue:item:${value}`:`catalogue:${value}`;
 const leaves=(children:ReturnType<typeof def>[])=>version===2?children.map(child=>({...child,expand:false})):children;
 g=advanceStageGraph(g,id('architecture'),{children:[]});
 g=advanceStageGraph(g,id('modules/notes'),{children:leaves([def('method',['modules/notes']),def('references',['method']),def('templates',['method']),def('scripts',['method'])])});
 g=advanceStageGraph(g,id('outside'),{children:[]});
 if(version===1)for(const leaf of ['method','references','templates','scripts'])g=advanceStageGraph(g,id(`modules/notes/${leaf}`),{children:[]});
 if(version===2){const artifact=buildCatalogueArtifact(g);g=advanceStageGraph(g,'catalogue:complete',artifact as any);}
 const page=(name:string)=>g.nodes.find(n=>n.id===`generate:${name}`)!;
 expect(page('modules/notes/method').definition!.dependencies).toEqual(['architecture']);
 expect(page('modules/notes/references').definition!.dependencies).toEqual(['architecture','modules/notes/method']);
 expect([...page('outside').definition!.dependencies].sort()).toEqual(['modules/notes/method','modules/notes/references','modules/notes/scripts','modules/notes/templates']);
});

it.each([1,2])('v%i still rejects a real cycle between sibling pages',version=>{
 const def=(id:string,dependencies:string[]=[])=>({id,title:id,goal:id,dependencies});let g=buildWikiStageGraph({inputHash:'s',...(version===2?{version:2 as const}:{})});
 g=advanceStageGraph(g,'prepare',{});if(version===2)g=advanceStageGraph(g,'readme',{});g=advanceStageGraph(g,'overview',{});g=advanceStageGraph(g,'plan',{items:[def('group')]});
 if(version===2)g=advanceStageGraph(g,'catalogue:root',{children:[def('group')]});
 expect(()=>advanceStageGraph(g,version===2?'catalogue:item:group':'catalogue:group',{children:[def('a',['b']),def('b',['a'])]})).toThrow('DEPENDENCY_CYCLE');
});
it.each([1,2])('v%i still rejects real cycles introduced by cross-group expansion',version=>{
 const def=(id:string,dependencies:string[]=[],expand?:boolean)=>({id,title:id,goal:id,dependencies,...(expand===undefined?{}:{expand})});let g=buildWikiStageGraph({inputHash:'s',...(version===2?{version:2 as const}:{})});
 g=advanceStageGraph(g,'prepare',{});if(version===2)g=advanceStageGraph(g,'readme',{});g=advanceStageGraph(g,'overview',{});const groups=[def('a'),def('b')];g=advanceStageGraph(g,'plan',{items:groups});if(version===2)g=advanceStageGraph(g,'catalogue:root',{children:groups});
 const node=(id:string)=>version===2?`catalogue:item:${id}`:`catalogue:${id}`;
 g=advanceStageGraph(g,node('a'),{children:[def('alpha',['b'],version===2?false:undefined)]});
 g=advanceStageGraph(g,node('b'),{children:[def('beta',['a'],version===2?false:undefined)]});
 if(version===2)expect(()=>buildCatalogueArtifact(g)).toThrow('DEPENDENCY_CYCLE');
 else {g=advanceStageGraph(g,node('a/alpha'),{children:[]});expect(()=>advanceStageGraph(g,node('b/beta'),{children:[]})).toThrow('DEPENDENCY_CYCLE');}
});
