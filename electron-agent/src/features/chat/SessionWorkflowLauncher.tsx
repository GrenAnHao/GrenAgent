import { applyNavigationDraft } from './sessionWorkflowDrafts';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Space } from 'antd';
import { pi } from '../../lib/pi';
import { SessionWorkflowPanel } from './SessionWorkflowPanel';
import type { SessionTreeDto, SessionWorkflowAck, SessionWorkflowRequest } from '../../../electron/app/sessionWorkflowContracts';
import type { AgentStoreApi } from '../../stores/agent';
import { useSessionStore } from '../../store/session';
import { useComposerFilesStore } from './input/composerFiles';
import { useChatDraftStore } from '../../stores/chatDraftStore';
import { readComposerSnapshot } from './input/composerBridge';
export function SessionWorkflowLauncher({workspace,sessionPath,store,ownerKey}:{workspace:string;sessionPath:string|null|undefined;store:AgentStoreApi;ownerKey:string}){
 const [open,setOpen]=useState(false),[tree,setTree]=useState<SessionTreeDto>(),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const owner=useRef({workspace,sessionPath});owner.current={workspace,sessionPath};
 useEffect(()=>{setOpen(false);setTree(undefined);setError('');},[workspace,sessionPath]);
 const refresh=async()=>{
  const expected={workspace,sessionPath};setLoading(true);setError('');
  try{const ack=await pi.sessionWorkflow(workspace,{action:'tree',...(sessionPath?{targetSessionPath:sessionPath}:{})});if(owner.current.workspace===expected.workspace&&owner.current.sessionPath===expected.sessionPath){setTree(ack.tree);setOpen(true);}}
  catch(e){setError(String(e));setOpen(true);}finally{setLoading(false);}
 };
 const applied=async(ack:SessionWorkflowAck)=>{
   if(ack.tree)setTree(ack.tree);
   const source=tree?.targetSessionPath;
   if(owner.current.workspace!==workspace||owner.current.sessionPath!==sessionPath)return;
   if(ack.status==='persisted-needs-reload'){store.useStore.setState({sessionNeedsReload:true,lastError:ack.notice});return;}
   if(ack.status!=='ok')return;
   if(ack.sessionPath){
     if(ack.editorText!==undefined)useChatDraftStore.getState().setDraft(ack.sessionPath,ack.editorText);
     const sessions=useSessionStore.getState();const targetWorkspace=ack.cwd??workspace;
     sessions.setWorkspaceSessionPath(targetWorkspace,ack.sessionPath);sessions.setActiveWorkspace(targetWorkspace);sessions.setActiveSession(ack.sessionPath);
     void pi.listAllSessions().then(s=>useSessionStore.getState().syncAllSessions(s));setOpen(false);return;
   }
   if(ack.editorText!==undefined&&source)applyNavigationDraft(ownerKey,ack.editorText);
   if(ack.tree&&source){const result=await pi.getMessages(workspace,source);if(owner.current.sessionPath===sessionPath)store.loadMessages(result.messages,{force:true,sessionPath:source});}
 };
 const request=async(r:SessionWorkflowRequest)=>{const ack=await pi.sessionWorkflow(workspace,r);return ack;};
 const reopen=async()=>{if(!tree?.targetSessionPath)return;try{const ack=await pi.sessionWorkflow(workspace,{...tree,action:'reload'});if(ack.tree)setTree(ack.tree);store.useStore.setState({sessionNeedsReload:false,lastError:undefined});await refresh();const result=await pi.getMessages(workspace,tree.targetSessionPath);store.loadMessages(result.messages,{force:true,sessionPath:tree.targetSessionPath});}catch(e){setError(String(e));}};
 return <><div style={{display:'flex',justifyContent:'flex-end'}}><Button type="text" size="small" loading={loading} onClick={()=>void refresh()}>会话树与本地文件</Button></div>
 <Drawer title="会话树与本地文件" open={open} onClose={()=>setOpen(false)} width="min(860px,100vw)" destroyOnHidden>
 {error&&<Alert type="error" title={error}/>}<Space style={{marginBottom:12}}><Button onClick={()=>void refresh()}>刷新</Button>{tree?.needsReload&&<Button onClick={()=>void reopen()}>重开原会话</Button>}</Space>
 {tree&&<SessionWorkflowPanel tree={tree} readDraft={()=>{const live=readComposerSnapshot();if(live?.ownerKey===ownerKey)return live;const draft=useChatDraftStore.getState().getDraft(ownerKey),files=useComposerFilesStore.getState().byKey[ownerKey];return{hasContent:Boolean(draft.text.length||files?.attachments.length||files?.pastedTexts.length)};}} request={request} onApplied={applied}/>}</Drawer></>;
}
