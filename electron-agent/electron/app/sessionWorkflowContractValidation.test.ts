import { expect,it } from 'vitest';
import { parseSessionWorkflowRequest } from './sessionWorkflowContractValidation.js';
it('requires explicit owner identity/leaf/revision for mutations and accepts null-root',()=>{expect(()=>parseSessionWorkflowRequest({action:'edit',entryId:'x',text:'x'})).toThrow(/identity/i);expect(parseSessionWorkflowRequest({action:'navigate',targetSessionPath:'/A',expectedSessionId:'A',expectedLeafId:null,expectedRevision:'host:1',entryId:'x',draftChoice:'keep'}).expectedLeafId).toBeNull();expect(()=>parseSessionWorkflowRequest({action:'shell'})).toThrow();});

it('rejects truthy non-boolean overwrite authority before reaching the filesystem owner',()=>{
 expect(()=>parseSessionWorkflowRequest({action:'export',targetSessionPath:'/A',expectedSessionId:'A',expectedLeafId:null,expectedRevision:'host:1',ticket:'ticket',overwrite:'false'})).toThrow(/overwrite.*boolean/i);
});
