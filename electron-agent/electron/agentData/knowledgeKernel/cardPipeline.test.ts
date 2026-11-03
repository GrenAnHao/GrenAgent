import { describe,it,expect } from 'vitest';
import { buildCardStageGraph } from './cardPipeline';
import { advanceStageGraph } from './pipeline';
import { validateStageResult } from './validation';
describe('cards graph',()=>{
 it('makes synthesis depend on module cards',()=>{let g=buildCardStageGraph({inputHash:'s'});g=advanceStageGraph(g,'prepare',{});g=advanceStageGraph(g,'plan',{items:[{id:'api',title:'API',goal:'api',dependencies:[]}]});expect(g.nodes.find(n=>n.id==='card:repository')?.deps).toContain('card:api');});
 it('rejects self relations and duplicates',()=>{const r={phase:'relations' as const,endpoints:['a','b'],relationTypes:['uses']};expect(()=>validateStageResult(r,{relations:[{from:'a',to:'a',type:'uses'}]})).toThrow();expect(()=>validateStageResult(r,{relations:[{from:'a',to:'b',type:'uses'},{from:'a',to:'b',type:'uses'}]})).toThrow();});
});
it('reserves the repository synthesis ID so module cards cannot collide',()=>{
 let g=buildCardStageGraph({inputHash:'s'});g=advanceStageGraph(g,'prepare',{});expect(()=>advanceStageGraph(g,'plan',{items:[{id:'repository',title:'Repository',goal:'module',dependencies:[]}]})).toThrow();
});
