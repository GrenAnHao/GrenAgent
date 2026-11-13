import { applyNavigationDraft } from '../src/features/chat/sessionWorkflowDrafts';
import { useChatDraftStore } from '../src/stores/chatDraftStore';
import { useState, useRef } from 'react';
import { SessionWorkflowPanel } from '../src/features/chat/SessionWorkflowPanel';
import type { SessionTreeDto, SessionWorkflowAck, SessionWorkflowRequest } from '../electron/app/sessionWorkflowContracts';
import { deferred, exposeActions, exposeData, track } from './stubs';
const leaf={id:'assistant',parentId:'user',type:'message',role:'assistant',preview:'当前助手回复',original:[{type:'text',text:'当前助手回复'},{type:'thinking',thinking:'协议签名内容',thinkingSignature:'signed'}],effective:[{type:'text',text:'当前摘要'}],replaced:true,inContext:true,current:true,onBranch:true,legacyExcluded:false,children:[]};
const initial:SessionTreeDto={targetSessionPath:'D:/sessions/A.jsonl',expectedSessionId:'A',expectedLeafId:'assistant',expectedRevision:'host:1',busy:false,needsReload:false,nodes:[{id:'user',parentId:null,type:'message',role:'user',preview:'最初用户请求',original:'最初用户请求',effective:'最初用户请求',replaced:false,inContext:true,current:false,onBranch:true,legacyExcluded:false,children:[leaf,{id:'side',parentId:'user',type:'message',role:'user',preview:'旁支请求',original:'旁支请求',replaced:false,inContext:false,current:false,onBranch:false,legacyExcluded:false,children:[{id:'technical',parentId:'side',type:'custom',preview:'技术记录',replaced:false,inContext:false,current:false,onBranch:false,legacyExcluded:false,children:[]}]}]}]};
const draftKey='D:/sessions/A.jsonl';useChatDraftStore.getState().setDraft(draftKey,'本来的草稿');
export function SessionWorkflowFixture({tab}:{tab:'tree'|'context'|'portability'}){
 const [tree,setTree]=useState<SessionTreeDto>(structuredClone(initial));const [epoch,setEpoch]=useState(0);const rejectNext=useRef('');const [summary]=useState(()=>deferred<SessionWorkflowAck>());
 exposeActions({draftEmpty:()=>useChatDraftStore.getState().clearDraft(draftKey),omit:()=>setTree(t=>({...t,nodes:[{...t.nodes[0],omitted:true,inWindow:true,inContext:false,replaced:true,effective:undefined}]})),busy:()=>setTree(t=>({...t,busy:true})),idle:()=>setTree(t=>({...t,busy:false})),stale:()=>{rejectNext.current='SESSION_STALE: 会话位置已变化，请刷新预览';},rejectPair:()=>{rejectNext.current='工具调用与结果配对校验失败，请保留协议块';},badImport:()=>{rejectNext.current='JSONL line 3: invalid JSON';},remount:()=>setEpoch(e=>e+1),exclude:()=>setTree(t=>({...t,nodes:[{...t.nodes[0],legacyExcluded:true}]})),refreshFail:()=>setTree(t=>({...t,needsReload:true})),summaryDone:()=>summary.resolve({status:'ok'}),reset:()=>setTree(structuredClone(initial))});
 const request=async(r:SessionWorkflowRequest):Promise<SessionWorkflowAck>=>{
  track(`${r.action}:${r.entryId??''}:${r.position??''}:${r.draftChoice??''}`);
  if(rejectNext.current){const error=rejectNext.current;rejectNext.current='';throw Error(error);}
  if(r.action==='import')track('preferences:'+r.preferenceChoice);
  if(r.action==='export')track('overwrite:'+String(r.overwrite));
  if(r.action==='fork-preview'||r.action==='clone-preview')return{status:'ok',scope:r.action==='clone-preview'?'复制当前分支（非完整会话树）':r.position==='at'?'根至所选节点（包含目标）':'所选用户消息之前（不含目标）',nodeCount:r.position==='before'?0:r.action==='clone-preview'?2:1,targetLeafId:r.position==='before'?null:'user',preview:r.position==='before'?[]:[{id:'user',type:'message',role:'user',preview:'最初用户请求'},...(r.action==='clone-preview'?[{id:'assistant',type:'message',role:'assistant',preview:'当前助手回复'}]:[])]};
  if(r.action==='label'){setTree(t=>({...t,nodes:t.nodes.map(n=>({...n,label:r.label}))}));return{status:'ok'};}
  if(r.action==='navigate-preview')return{status:'ok',targetLeafId:r.entryId==='user'?null:'assistant',editorText:r.entryId==='user'?'最初用户请求':undefined};
  if(r.action==='navigate'&&r.summarize)return summary.promise;
  if(r.action==='navigate')return{status:'ok',editorText:r.draftChoice==='replace'&&r.entryId==='user'?'最初用户请求':undefined};
  if(r.action==='cancel-summary'){summary.resolve({status:'cancelled'});return{status:'cancelled'};}
  if(r.action==='export-preview')return{status:'ok',ticket:'export-ticket',format:r.format,destination:'D:/exports/完整历史.'+r.format,exists:r.format==='html',scope:r.format==='html'?'HTML：完整会话树':'JSONL：当前分支（不是全树备份）',nodeCount:4};
  if(r.action==='import-preview')return{status:'ok',ticket:'import-ticket',cwd:'D:/repo',nodeCount:4,preview:[{role:'user',content:'只读历史预览'}]};
  return{status:'ok'};
 };
 return <main style={{height:'100vh',overflow:'auto',padding:24,boxSizing:'border-box',background:'var(--gren-content-bg)',color:'var(--gren-text)'}}><div style={{maxWidth:800,margin:'0 auto'}}><h2>会话工作流</h2><SessionWorkflowPanel key={epoch} tree={tree} readDraft={()=>({hasContent:useChatDraftStore.getState().getDraft(draftKey).text.length>0})} request={request} onApplied={ack=>{if(ack.editorText!==undefined)applyNavigationDraft(draftKey,ack.editorText);exposeData({draft:useChatDraftStore.getState().getDraft(draftKey).text});}} tab={tab}/></div></main>;
}
