import { expect, it } from 'vitest';
import { workspaceBudget, toolBudget } from './mcpBudget';

it('sums live sizes before rounding, counts enabled cache without injecting it, and respects exposure and policy', () => {
 const entry=(name:string,enabled=true)=>({name,enabled,config:{command:'node',exposure:'direct'}});
 const names=['mcp__s__a','mcp__s__b','mcp__s__c'];
 const summary=workspaceBudget([entry('s'),entry('off',false),entry('cached')], [
   {name:'s',status:'connected',tools:3,toolNames:names,footprints:[[601,'direct'],[901,'codemode'],[5000,'hidden']]},
   {name:'off',status:'connected',tools:1,toolNames:['off'],footprints:[[90000,'direct']]},
 ],{cached:{ok:true,probedAt:'',toolNames:['mcp__cached__a']}}, {tools:{[names[0]]:{permission:'disabled'}}});
 expect(summary).toMatchObject({enabled:2,available:2,direct:'151',partial:true});
 expect(summary.byServer.get('s')).toMatchObject({available:1,permittedChars:901,directChars:601});
});

it('separates callable schema size from direct exposure, including inherited permissions', () => {
 const names=['mcp__s__a','mcp__s__b'];
 const catalog=new Map(names.map((fullName,i)=>[fullName,{name:i?'b':'a',fullName,description:'x'.repeat(400)}]));
 const policy={defaultPermission:'disabled',tools:{[names[1]]:{permission:'auto'}}};
 const b=toolBudget(names,catalog,true,policy,'codemode',{a:'direct'});
 expect(b.available).toBe(1); expect(Number(b.permitted)).toBeGreaterThan(100);
 expect(Number(b.direct)).toBeGreaterThan(100);
 expect(toolBudget(names,catalog,false,policy)).toMatchObject({available:0,direct:'0',permitted:'0'});
});
