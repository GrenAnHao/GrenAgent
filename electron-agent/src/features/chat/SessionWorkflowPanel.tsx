import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, Radio, Space, Tabs, Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import type { SessionTreeDto, SessionTreeNodeDto, SessionWorkflowAck, SessionWorkflowRequest } from '../../../electron/app/sessionWorkflowContracts';
const {Text,Paragraph}=Typography;
export interface SessionWorkflowPanelProps {
  tree:SessionTreeDto;
  request:(request:SessionWorkflowRequest)=>Promise<SessionWorkflowAck>;
  onApplied:(ack:SessionWorkflowAck)=>void|Promise<void>;
  tab?:'tree'|'context'|'portability';
  readDraft?:()=>{hasContent:boolean};
}
const textOf=(c:unknown):string=>typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text).join('\n'):'';
const allNodes=(nodes:SessionTreeNodeDto[]):SessionTreeNodeDto[]=>nodes.flatMap(n=>[n,...allNodes(n.children)]);
export function SessionWorkflowPanel({tree,request,onApplied,tab='tree',readDraft=()=>({hasContent:false})}:SessionWorkflowPanelProps){
  const [active,setActive]=useState(tab),[selected,setSelected]=useState<string>(),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const [label,setLabel]=useState(''),[text,setText]=useState(''),[summarize,setSummarize]=useState(false),[draftChoice,setDraftChoice]=useState<'keep'|'replace'>(),[navigationHasDraft,setNavigationHasDraft]=useState(false);
  const [derivation,setDerivation]=useState<{request:SessionWorkflowRequest;preview:SessionWorkflowAck}>();
  const [navigation,setNavigation]=useState<SessionWorkflowAck>(),[exported,setExported]=useState<SessionWorkflowAck>(),[imported,setImported]=useState<SessionWorkflowAck>(),[cwd,setCwd]=useState(''),[preferenceChoice,setPreferenceChoice]=useState<'file'|'current'>('file');
  const nodes=allNodes(tree.nodes),node=nodes.find(n=>n.id===selected);
  useEffect(()=>{setSelected(undefined);setNavigation(undefined);setDerivation(undefined);setExported(undefined);setImported(undefined);},[tree.targetSessionPath]);
  useEffect(()=>{setLabel(node?.label??'');setText(textOf(node?.effective??node?.original));},[node?.id,node?.effective]);
  const disabled=pending||tree.busy||tree.needsReload;
  const call=async(r:SessionWorkflowRequest)=>{
    setError('');setPending(true);
    try{const ack=await request({targetSessionPath:tree.targetSessionPath,expectedSessionId:tree.expectedSessionId,expectedLeafId:tree.expectedLeafId,expectedRevision:tree.expectedRevision,...r});if(ack.status==='persisted-needs-reload')setError(ack.notice??'已保存，请重开原会话');if(['label','navigate','edit','restore-original','fork','clone','export','import'].includes(r.action))await onApplied(ack);return ack;}
    catch(e){setError(e instanceof Error?e.message:String(e));return undefined;}finally{setPending(false);}
  };
  const target={targetSessionPath:tree.targetSessionPath,expectedSessionId:tree.expectedSessionId,expectedLeafId:tree.expectedLeafId,expectedRevision:tree.expectedRevision};
  const navigationTarget=navigation?.tree?{targetSessionPath:navigation.tree.targetSessionPath,expectedSessionId:navigation.tree.expectedSessionId,expectedLeafId:navigation.tree.expectedLeafId,expectedRevision:navigation.tree.expectedRevision}:target;
  const previewNavigation=async()=>{
    const ack=await call({action:'navigate-preview',entryId:selected});if(!ack||ack.status!=='ok')return;
    const hasDraft=ack.editorText!==undefined&&readDraft().hasContent;
    setNavigationHasDraft(hasDraft);setDraftChoice(hasDraft?undefined:ack.editorText!==undefined?'replace':'keep');setNavigation(ack);
  };
  const previewDerivation=async(operation:'fork'|'clone',position?:'before'|'at')=>{
    const commit:SessionWorkflowRequest={...target,action:operation,...(operation==='fork'?{entryId:selected,position}: {})};
    const ack=await call({...commit,action:operation==='fork'?'fork-preview':'clone-preview'});
    if(ack?.status==='ok')setDerivation({request:commit,preview:ack});
  };
  const data=(ns:SessionTreeNodeDto[]):DataNode[]=>ns.map(n=>({key:n.id,title:<span><Text type={n.onBranch?undefined:'secondary'}>{n.current?'● ':''}{n.label?`★ ${n.label} · `:''}{n.preview||n.type}</Text><Text type="secondary"> · {n.role??n.type}</Text></span>,children:data(n.children)}));
  const choose=(keys:React.Key[])=>{setSelected(String(keys[0]??''));setNavigation(undefined);};
  return <section data-testid="session-workflow-panel" style={{minWidth:0}}>
    {tree.notice&&<Alert type="info" showIcon title={tree.notice} style={{marginBottom:12}}/>}
    {tree.busy&&<Alert type="warning" title="会话正在处理请求，结构操作暂不可用" style={{marginBottom:12}}/>}
    {tree.needsReload&&<Alert type="error" title="修改已保存；请重开原会话后再发送" style={{marginBottom:12}}/>}
    {error&&<Alert type="error" showIcon title={error} style={{marginBottom:12}}/>}
    <Tabs activeKey={active} onChange={setActive} items={[
      {key:'tree',label:'会话树',children:<>
        <Paragraph type="secondary">同文件导航保留所有旁支。分叉和复制只保留所选路径，生成独立会话。</Paragraph>
        <div style={{maxHeight:320,overflow:'auto',border:'1px solid var(--ant-color-border-secondary)',borderRadius:8,padding:8}}><Tree aria-label="会话树节点" treeData={data(tree.nodes)} defaultExpandedKeys={nodes.filter(n=>n.onBranch).map(n=>n.id)} selectedKeys={selected?[selected]:[]} onSelect={choose}/></div>
        {node&&<Space direction="vertical" style={{width:'100%',marginTop:16}}>
          <Space.Compact style={{width:'100%'}}><Input aria-label="节点书签" placeholder="为节点添加书签（不修改会话标题）" value={label} onChange={e=>setLabel(e.target.value)}/><Button disabled={disabled} onClick={()=>void call({action:'label',entryId:node.id,label})}>保存书签</Button><Button disabled={disabled||!node.label} onClick={()=>void call({action:'label',entryId:node.id,label:''})}>移除</Button></Space.Compact>
          <Space wrap><Button disabled={disabled} onClick={()=>void previewNavigation()}>预览继续位置</Button><Button disabled={disabled||node.role!=='user'} onClick={()=>void previewDerivation('fork','before')}>从此之前分叉</Button><Button disabled={disabled} onClick={()=>void previewDerivation('fork','at')}>从此处分叉</Button></Space>
        </Space>}
        {navigation&&<div style={{marginTop:16,padding:16,background:'var(--ant-color-fill-quaternary)',borderRadius:8}} data-testid="navigation-preview">
          <Paragraph>继续位置：{navigation.targetLeafId??'根位置（首条消息之前）'}</Paragraph>
          {navigation.editorText!==undefined&&<><pre style={{whiteSpace:'pre-wrap',maxHeight:140,overflow:'auto'}}>{navigation.editorText}</pre>{navigationHasDraft?<><Paragraph>当前草稿已有内容，请明确选择如何处理。</Paragraph><Radio.Group aria-label="已有草稿处理" value={draftChoice} onChange={e=>setDraftChoice(e.target.value)} options={[{value:'keep',label:'保留现有草稿'},{value:'replace',label:'替换为节点原文'}]}/></>:<Paragraph>草稿为空，确认后将填入上方原文，不会自动发送。</Paragraph>}</>}
          <p><Checkbox checked={summarize} onChange={e=>setSummarize(e.target.checked)}>总结离开分支（可能调用模型）</Checkbox></p>
          <Space><Button type="primary" disabled={disabled||!draftChoice} onClick={()=>void call({...navigationTarget,action:'navigate',entryId:selected,summarize,draftChoice}).then(a=>{if(a?.status==='ok')setNavigation(undefined);})}>确认导航</Button><Button onClick={()=>setNavigation(undefined)}>取消</Button><Button disabled={!pending} onClick={()=>void request({...target,action:'cancel-summary'})}>取消摘要</Button></Space>
        </div>}
        <Button style={{marginTop:16}} disabled={disabled} onClick={()=>void previewDerivation('clone')}>复制当前分支</Button>
        {derivation&&<section data-testid="derivation-preview" style={{marginTop:16,padding:16,background:'var(--ant-color-fill-quaternary)',borderRadius:8}}>
          <Paragraph strong>{derivation.preview.scope}</Paragraph><Paragraph>将保留 {derivation.preview.nodeCount} 个源路径条目；适用书签、当前五项偏好和旧排除快照会独立初始化。源文件、旁支和草稿保留。</Paragraph>
          <ol style={{maxHeight:220,overflow:'auto',paddingLeft:24}}>{(Array.isArray(derivation.preview.preview)?derivation.preview.preview:[]).map((entry,index)=><li key={entry.id??index}>{entry.role??entry.type} · {String(entry.preview??entry.type??'')}</li>)}</ol>
          <details><summary>新会话独立偏好</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(derivation.preview.requestedPreferences,null,2)}</pre></details>
          <Space style={{marginTop:12}}><Button type="primary" disabled={disabled} onClick={()=>void call(derivation.request).then(ack=>{if(ack?.status==='ok')setDerivation(undefined);})}>{derivation.request.action==='clone'?'确认复制':'确认分叉'}</Button><Button onClick={()=>setDerivation(undefined)}>{derivation.request.action==='clone'?'取消复制':'取消分叉'}</Button></Space>
        </section>}

      </>},
      {key:'context',label:'上下文内容',children:<>
        <Paragraph type="secondary">只替换下一轮使用的文本；原始历史、图片、工具关联、签名和历史用量保留。</Paragraph>
        <Radio.Group aria-label="编辑目标" value={selected} onChange={e=>setSelected(e.target.value)} style={{display:'flex',flexDirection:'column',gap:8}}>{nodes.filter(n=>n.onBranch&&n.original!==undefined&&(n.type==='custom_message'||['user','assistant','toolResult','custom'].includes(n.role??''))).map(n=><Radio key={n.id} value={n.id}>{n.preview.slice(0,90)}{n.replaced?' · 本分支上下文已替换':''}{n.legacyExcluded?' · 旧版会话排除':''}</Radio>)}</Radio.Group>
        {node&&<div style={{marginTop:16}}>
          {node.omitted&&<Alert title="本分支已省略该条内容；原始历史仍保留，旧版会话排除独立生效" type="info"/>}
          {node.inWindow===false&&<Alert title="不在当前有效窗口；恢复内容不会重新纳入已压缩历史" type="info"/>}
          {node.legacyExcluded&&<Alert title="请先从原消息的恢复入口恢复旧版会话排除，再保存替换。恢复原文不会撤销排除。" type="warning"/>}
          <details><summary>持久原文（完整内容）</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{typeof node.original==='string'?node.original:JSON.stringify(node.original,null,2)}</pre></details>
          <details open><summary>当前有效内容</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{textOf(node.effective)}</pre></details>
          <Input.TextArea aria-label="替换文本" autoSize={{minRows:4,maxRows:12}} value={text} onChange={e=>setText(e.target.value)}/>
          <Space style={{marginTop:12}}><Button type="primary" disabled={disabled||node.legacyExcluded} onClick={()=>void call({action:'edit',entryId:node.id,text})}>保存替换</Button><Button disabled={disabled||!node.replaced} onClick={()=>void call({action:'restore-original',entryId:node.id})}>恢复原始完整内容</Button></Space>
        </div>}
      </>},
      {key:'portability',label:'导出与导入',children:<>
        <Alert type="warning" showIcon title="文件保留敏感原文" description="消息、系统提示、工具参数及结果、文件内容都可能包含敏感信息。上下文替换或排除不会从导出中删除原文；未落盘草稿不包含在文件中。"/>
        <Space wrap style={{marginBlock:16}}><Button disabled={disabled} onClick={()=>void call({action:'export-preview',format:'html'}).then(setExported)}>导出 HTML · 完整会话树</Button><Button disabled={disabled} onClick={()=>void call({action:'export-preview',format:'jsonl'}).then(setExported)}>导出 JSONL · 当前分支</Button><Button disabled={disabled} onClick={()=>void call({action:'import-preview'}).then(a=>{setImported(a);setCwd(a?.cwd??'');})}>导入本地 JSONL</Button></Space>
        {exported&&<div data-testid="export-preview"><Paragraph><strong>{exported.scope}</strong> · {exported.nodeCount} 个条目</Paragraph><Paragraph copyable>{exported.destination}</Paragraph>{exported.exists&&<Alert type="warning" title="目标已存在；确认将覆盖该文件"/>}<Space><Button type="primary" disabled={disabled} onClick={()=>void call({action:'export',ticket:exported.ticket,overwrite:exported.exists}).then(a=>{if(a?.status==='ok')setExported(undefined);})}>{exported.exists?'确认覆盖并导出':'确认导出'}</Button><Button onClick={()=>setExported(undefined)}>取消导出</Button></Space></div>}
        {imported&&<div data-testid="import-preview"><Paragraph>只读预览 · {imported.nodeCount} 个条目。历史用量只展示，不计入本机累计；不会自动发送、预热或执行历史工具。</Paragraph><pre style={{maxHeight:180,overflow:'auto',whiteSpace:'pre-wrap'}}>{JSON.stringify(imported.preview,null,2)}</pre><Paragraph>待确认的模型请求偏好：</Paragraph><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(imported.requestedPreferences,null,2)}</pre><Radio.Group aria-label="导入偏好选择" value={preferenceChoice} onChange={e=>setPreferenceChoice(e.target.value)} options={[{value:'file',label:'采用文件中的模型、思考与 Fast（缺失模型保持不可用）'},{value:'current',label:'使用当前本地请求偏好'}]}/><Input aria-label="确认导入工作目录" value={cwd} onChange={e=>setCwd(e.target.value)} placeholder="有效本地工作目录"/><Paragraph type="secondary">模型、思考及 Fast 可在导入后另行选择；审批与模式使用当前本地安全选择，不继承文件的高权限声明。</Paragraph><Space><Button type="primary" disabled={disabled||!cwd.trim()} onClick={()=>void call({action:'import',ticket:imported.ticket,cwd,preferenceChoice}).then(a=>{if(a?.status==='ok')setImported(undefined);})}>确认目录并导入（不发送）</Button><Button onClick={()=>setImported(undefined)}>取消导入</Button></Space></div>}
      </>},
    ]}/>
  </section>;
}

