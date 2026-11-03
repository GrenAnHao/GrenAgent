import { describe,it,expect } from 'vitest';
import { prepareRepair } from './incremental';
describe('repair',()=>{it('creates a new lineage and reuses matching validated items',()=>{const p={taskId:'old',identity:'v1',items:[{id:'a',status:'validated',inputHash:'x'},{id:'b',status:'failed',inputHash:'y'}]};expect(prepareRepair(p,{taskId:'new',identity:'v1',inputs:{a:'x',b:'y'}})).toMatchObject({taskId:'new',retryOf:'old',reused:['a'],redo:['b']});expect(()=>prepareRepair(p,{taskId:'old',identity:'v1',inputs:{}})).toThrow();});});
it('requires confirmation when source identity of an item changed',()=>{
 const p={taskId:'old',identity:'v1',items:[{id:'a',status:'validated',inputHash:'old'}]};
 expect(prepareRepair(p,{taskId:'new',identity:'v1',inputs:{a:'new'}})).toMatchObject({reused:[],redo:['a'],confirmationRequired:true});
});
