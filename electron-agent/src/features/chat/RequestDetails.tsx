import {costSourceLabel} from '../../lib/usageReport';
import {useEffect,useState} from 'react';
import {Button,Switch} from 'antd';
import {createStaticStyles,cssVar} from 'antd-style';
import {pi} from '../../lib/pi';
import {listen} from '../../platform/runtime';
import {useRequestObservations,requestKey} from '../../stores/requestObservations';
import type {RequestObservation} from '../../../../extensions/_shared/requestObservation';
import type {WarmingSnapshot} from '../../../electron/app/requestObservationService';

const styles=createStaticStyles(({css})=>({root:css`color:${cssVar.colorText};font-size:13px;`,
 panel:css`padding:12px 14px;border:1px solid ${cssVar.colorBorderSecondary};border-radius:8px;background:${cssVar.colorBgContainer};max-height:380px;overflow:auto;`,
 grid:css`display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:10px 0;`,
 label:css`display:block;color:${cssVar.colorTextDescription};font-size:12px;margin-bottom:3px;`,
 actions:css`display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px;`,
 pre:css`max-height:180px;overflow:auto;background:${cssVar.colorFillQuaternary};padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;`,
 summary:css`cursor:pointer;padding:6px 0;color:${cssVar.colorTextSecondary};`,
}));
const money=(v:number|undefined)=>v===undefined?'未知':`$${v.toFixed(6)} USD`;

export function WarmingDetails({snapshot}:{snapshot:WarmingSnapshot|null}){
 const s=snapshot?.status;const d=s?.decision;const action=s?.extensionOverride?(s.state==='inactive'?'stop':'warm'):d?.action;
 return <section data-testid="warming-observation"><strong>缓存预热</strong><div className={styles.grid}>
  <div><span className={styles.label}>官方状态</span>{!s?'不可用':s.state==='scheduled'?'已排期（尚未发送）':s.state==='refreshing'?'正在预热':'未运行'}</div>
  {s?.nextWarmAt!==undefined?<div><span className={styles.label}>下次检查</span>{new Date(s.nextWarmAt).toLocaleTimeString()}</div>:null}
  <div><span className={styles.label}>预计预热费用</span>{money(d?.warmCost)}</div><div><span className={styles.label}>预计未命中费用</span>{money(d?.missCost)}</div>
  <div><span className={styles.label}>继续概率</span>{d?.continuationProbability===undefined?'未知':`${(d.continuationProbability*100).toFixed(0)}%`}</div>
  <div><span className={styles.label}>最终决定</span>{action==='warm'?'继续预热':action==='stop'?'停止':'未知'}{s?.extensionOverride?' · 扩展覆盖':''}</div>
 </div>{s?.reason?<div>{s.reason}</div>:null}{d?.economicsAvailable===false?<div>经济性无法估算</div>:null}<small>以上为官方估算；已发生的预热费用在用量页单列，估算不入账。</small></section>;
}
interface Scope{workspace?:string;sessionPath?:string|null;sessionId?:string;requestId?:string}
export function RequestObservationDetails(scope:Scope){
 const byId=useRequestObservations(s=>s.byId);const [warming,setWarming]=useState<WarmingSnapshot|null>(null);const [error,setError]=useState('');
 const [preview,setPreview]=useState<{previewId:string;events:unknown[]}|null>(null);const [exporting,setExporting]=useState(false);
 const matches=(s:RequestObservation)=>(scope.sessionId?s.identity.sessionId===scope.sessionId:scope.sessionPath?s.identity.sessionPath===scope.sessionPath:false)&&(!scope.requestId||s.identity.requestId===scope.requestId);
 const observations=Object.values(byId).filter(matches);const latest=observations.at(-1);
 const [selected,setSelected]=useState('');const observation=observations.find(s=>requestKey(s.identity)===selected)??latest;
 useEffect(()=>{
  let live=true;let off=()=>{};let offLifecycle=()=>{};let offExit=()=>{};const owned=new Map<string,RequestObservation['identity']>();
  const accept=(s:RequestObservation)=>{if(live&&matches(s)){owned.set(requestKey(s.identity),s.identity);useRequestObservations.getState().accept(s);}};
  const query={workspace:scope.workspace,sessionPath:scope.sessionPath??undefined,sessionId:scope.sessionId};
  let lastWarmingRead=0;
  const readWarming=()=>{if(Date.now()-lastWarmingRead<1000)return Promise.resolve();lastWarmingRead=Date.now();return pi.requestObservation<WarmingSnapshot>({action:'warming',...query}).then(s=>{if(live)setWarming(s);}).catch(()=>{if(live)setWarming(null);});};
  void pi.requestObservation<RequestObservation[]>({action:'list',...query}).then(rows=>{if(live)rows.forEach(accept);}).catch(e=>{if(live)setError(String(e));});
  void listen<RequestObservation>('pi://request-observation',e=>{accept(e.payload);}).then(fn=>{if(live)off=fn;else fn();});
  void listen<any>('pi://event',e=>{if(e.payload?.sessionId===scope.sessionId||e.payload?.sessionPath===scope.sessionPath)void readWarming();}).then(fn=>{if(live)offLifecycle=fn;else fn();});
  void listen<any>('pi://exit',e=>{
    const exit=e.payload;if(!exit?.sessionId&&!exit?.sessionPath&&(!scope.workspace||exit?.workspace!==scope.workspace))return;
    if(exit?.sessionId&&exit.sessionId!==scope.sessionId&&![...owned.values()].some(i=>i.sessionId===exit.sessionId))return;
    if(exit?.sessionPath&&exit.sessionPath!==scope.sessionPath&&!exit.sessionId)return;
    if(exit?.workspace&&scope.workspace&&exit.workspace!==scope.workspace)return;
    if(!live)return;setPreview(null);setWarming(null);
    for(const identity of owned.values())useRequestObservations.getState().disconnect(identity);
  }).then(fn=>{if(live)offExit=fn;else fn();});
  void readWarming();const timer=setInterval(()=>{if(!document.hidden)void readWarming();},1000);
  return()=>{live=false;clearInterval(timer);off();offLifecycle();offExit();for(const identity of owned.values()){void pi.requestObservation({action:'clear',identity}).catch(()=>{});useRequestObservations.getState().clear(identity);}};
 },[scope.workspace,scope.sessionPath,scope.sessionId,scope.requestId]);
 useEffect(()=>{setPreview(null);},[selected,scope.sessionId,scope.sessionPath,scope.requestId]);
 const action=async(name:string,extra:Record<string,unknown>={})=>{if(!observation)return;setError('');try{return await pi.requestObservation<any>({action:name,identity:observation.identity,...extra});}catch(e){setError(String(e));}};
 useEffect(()=>{if(observation?.availability==='unavailable'&&!observation.events.length&&!observation.collecting)setPreview(null);},[observation?.sequence,observation?.availability]);
 const terminal=observation&&['completed','failed','cancelled'].includes(observation.phase);
 return <div className={styles.root} data-testid="request-observation-details"><div className={styles.panel}>
  {!scope.requestId?<WarmingDetails snapshot={warming}/>:null}
  <div className={styles.actions}><strong>请求元数据</strong>{observations.length>1?<select aria-label="选择请求" value={observation?requestKey(observation.identity):''} onChange={e=>{if(observation)void action('clear');setSelected(e.target.value);}}>{observations.map(s=><option key={requestKey(s.identity)} value={requestKey(s.identity)}>{new Date(s.startedAt).toLocaleTimeString()} · {s.requestedModel} · {s.phase}</option>)}</select>:null}</div>
  {observation?<><div className={styles.grid}>
   <div><span className={styles.label}>请求模型</span>{observation.requestedModel}</div><div><span className={styles.label}>响应模型</span>{observation.outcome?.responseModel??'未报告'}</div>
   <div><span className={styles.label}>费用</span>{money(observation.outcome?.costTotal)} · {costSourceLabel(observation.outcome?.costSource)}</div>
   <div><span className={styles.label}>HTTP 元数据</span>{observation.responses.length?`${observation.responses.length} 个已观察响应`:'不可用（适配器未提供或响应前失败）'}</div>
  </div>{observation.responses.map(r=><div key={r.attempt}>已观察响应 {r.attempt} · HTTP {r.metadata.httpStatus??'未知'}{r.metadata.providerRequestId?` · ${r.metadata.providerRequestId}`:''}{Object.entries(r.metadata.rateLimit).map(([k,v])=><div key={k}>{k}: {v}</div>)}</div>)}
  <div className={styles.actions}><Switch size="small" aria-label="临时收集结构事件" checked={observation.collecting} disabled={!!terminal} onChange={enabled=>{if(!enabled)setPreview(null);void action('collect',{enabled});}}/><span>临时收集结构事件</span><Button data-testid="request-preview" size="small" onClick={()=>void action('preview').then(p=>{if(p)setPreview(p);})}>脱敏预览</Button><Button data-testid="request-clear" size="small" onClick={()=>{setPreview(null);void action('clear');}}>清除</Button>{preview?<Button data-testid="request-export" size="small" disabled={exporting} onClick={async()=>{setExporting(true);try{await pi.exportRequestObservation(preview.previewId);}catch(e){setError(`导出失败，可重试：${String(e)}`);}finally{setExporting(false);}}}>导出此预览</Button>:null}</div>
  {error?<div role="alert">{error}</div>:null}
  <p className={styles.label}>仅收启用后的事件；正文、思考、参数和秘密均隐藏。最多 200 条 / 1 MiB，关闭详情即清空，重开默认关闭。</p>
  {observation.availability==='truncated'?<div role="status">结构事件已截断，停止收集</div>:null}
  {preview?<><pre className={styles.pre} data-testid="request-structure-preview">{JSON.stringify(preview.events,null,2)}</pre></>:null}
  </>:<p>暂无当前作用域的请求观测；历史请求不会补采结构事件。</p>}
 </div></div>;
}
export function CurrentRequestDetails(scope:Scope){
 const [open,setOpen]=useState(false);
 useEffect(()=>setOpen(false),[scope.sessionPath,scope.sessionId,scope.requestId]);
 return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)} data-testid="current-request-details"><summary className={styles.summary}>请求与缓存预热详情</summary>{open?<RequestObservationDetails key={JSON.stringify([scope.workspace,scope.sessionPath,scope.sessionId,scope.requestId])} {...scope}/>:null}</details>;
}
