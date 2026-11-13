import type { SessionWorkflowRequest, SessionWorkflowAction } from './sessionWorkflowContracts.js';
const actions:SessionWorkflowAction[]=['tree','reload','label','navigate-preview','navigate','cancel-summary','edit','restore-original','fork-preview','clone-preview','fork','clone','export-preview','export','import-preview','import'];
export function parseSessionWorkflowRequest(raw:Record<string,unknown>):SessionWorkflowRequest{
  if(!actions.includes(raw.action as SessionWorkflowAction))throw new Error('Invalid session workflow action');
  if(raw.action!=='tree'&&(!raw.targetSessionPath||typeof raw.targetSessionPath!=='string'||typeof raw.expectedSessionId!=='string'||typeof raw.expectedRevision!=='string'||!(raw.expectedLeafId===null||typeof raw.expectedLeafId==='string')))throw new Error('Session identity, leaf and revision are required');
  for(const key of ['entryId','label','text','ticket','cwd'] as const)if(raw[key]!==undefined&&typeof raw[key]!=='string')throw new Error(`${key} must be a string`);
  if(raw.text!==undefined&&(raw.text as string).length>4*1024*1024)throw new Error('Context replacement exceeds 4 MiB');
  if(['label','navigate-preview','navigate','edit','restore-original','fork-preview','fork'].includes(String(raw.action))&&(typeof raw.entryId!=='string'||!raw.entryId))throw new Error('entryId is required');
  if(raw.action==='navigate'&&raw.draftChoice!=='keep'&&raw.draftChoice!=='replace')throw new Error('Explicit draft choice required');
  if(raw.position!==undefined&&raw.position!=='before'&&raw.position!=='at')throw new Error('position must be before or at');
  if(raw.overwrite!==undefined&&typeof raw.overwrite!=='boolean')throw new Error('overwrite must be boolean');
  if(raw.summarize!==undefined&&typeof raw.summarize!=='boolean')throw new Error('summarize must be boolean');
  return raw as unknown as SessionWorkflowRequest;
}

