import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {normalizeStageSources,validateStageResult} from '../../../electron-agent/electron/agentData/knowledgeKernel/validation';
import {hashKnowledgePayload} from '../../../electron-agent/electron/agentData/knowledgeKernel/store';
const db=new DatabaseSync(path.join(process.env.APPDATA!,'electron-agent','agent-data.db'),{readOnly:true});
const parent='4c12a6f4-e458-4d73-960c-d8ca7bbd78bd',current='f2cca0ce-1ed0-4687-9f2f-c4b6b71a0f93';
const cat=db.prepare("select item_id,payload from knowledge_build_items where task_id=? and phase='catalogue' and state='prepared'").all(parent) as any[];
const pages=cat.filter(r=>JSON.parse(r.payload).children.length===0).map(r=>r.item_id.slice(10));if(pages.length!==16)throw Error('PAGE_SET_NOT_16');const all:any[]=[];
for(const task of [parent,current]){
 const snapshot=JSON.parse((db.prepare('select manifest from knowledge_source_snapshots where task_id=?').get(task) as any).manifest);
 const rows=db.prepare("select item_id,state,payload,output_hash,evidence from knowledge_build_items where task_id=? and phase='generate' and "+(task===parent?"state='prepared'":"state='failed' and item_id='generate:modules/pocock/upstream'")).all(task) as any[];if(rows.length!==(task===parent?10:1))throw Error('UNEXPECTED_ROW_COUNT');
 for(const row of rows){const page=row.item_id.slice(9);try{
  const body=JSON.parse(row.payload);if(hashKnowledgePayload(body)!==row.output_hash)throw Error('ARTIFACT_HASH_MISMATCH');
  const ranges=JSON.parse(row.evidence).filter((e:any)=>e.kind==='read'&&snapshot.files[e.path]?.hash===e.hash&&e.startLine!==undefined&&e.endLine!==undefined).map((e:any)=>({path:e.path,start:e.startLine,end:e.endLine}));
  if(task===parent)validateStageResult({phase:'overview',files:snapshot.files,observedRanges:ranges},{summary:'source check',sources:body.sources});
  const normalized=normalizeStageSources('generate',body,snapshot.files,ranges,{pageId:page,pageIds:pages}) as any;validateStageResult({phase:'generate',files:snapshot.files,observedRanges:ranges,pageId:page,pageIds:pages},normalized);
  all.push({page,valid:true,warnings:normalized.navigationWarnings??[]});
 }catch(e){all.push({page,valid:false,error:(e as any)?.code??((e as Error).message.match(/^[A-Z_]+/)||['VALIDATION_FAILED'])[0]});}}
}
db.close();console.log(JSON.stringify(all,null,2));if(all.some(x=>!x.valid))process.exitCode=1;
