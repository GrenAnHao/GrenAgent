import { useEffect, useRef, useState } from 'react';
import type { NativeAuthor, NativeConfirmation, NativeIntent, NativeRequest, NativeResponse, NativeSnapshot, RepoWikiClient } from '../../../../packages/contracts/src/index';

type Props = { client: RepoWikiClient; projectId: string; onClose: () => void };
export function NativeWikiPanel({ client, projectId, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  const [author, setAuthor] = useState<NativeAuthor | null>(null);
  const [constraints, setConstraints] = useState('');
  const [notes, setNotes] = useState('');
  const [pages, setPages] = useState('[]');
  const [dirty, setDirty] = useState(false);
  const [confirmation, setConfirmation] = useState<NativeConfirmation | null>(null);
  const [drafts, setDrafts] = useState<Array<{ id: string; title: string; markdown: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestLimit, setRequestLimit] = useState('');
  const [tokenLimit, setTokenLimit] = useState('');
  const generation = useRef(0);
  const requestId = useRef('');
  const statusSerial = useRef(0);
  const invoke = (input: Omit<NativeRequest, 'project_id'>) => client.invoke('native', { ...input, project_id: projectId } as NativeRequest);
  const get = async <T extends NativeResponse['command']>(command: T, value: Omit<Extract<NativeRequest, { command: T }>, 'project_id' | 'command'> = {} as never): Promise<(NativeResponse & { command: T })['value']> => {
    const epoch = generation.current;
    const response = await invoke({ command, ...value } as Omit<NativeRequest, 'project_id'>);
    if (generation.current !== epoch) throw new Error('STALE_NATIVE_VIEW');
    if (response.command !== command) throw new Error('知识服务返回了不匹配的结果');
    return response.value as (NativeResponse & { command: T })['value'];
  };
  const applyAuthor = (next: NativeAuthor) => { setAuthor(next); setConstraints(next.constraints.join('\n')); setNotes(JSON.stringify(next.notes, null, 2)); setPages(JSON.stringify(next.pages, null, 2)); setDirty(false); setConfirmation(null); };
  useEffect(() => {
    const epoch = ++generation.current;
    setSnapshot(null); setAuthor(null); setConfirmation(null); setDrafts([]); setDirty(false); setBusy(false); setError('');
    void get('status').then(status => { if (generation.current === epoch) setSnapshot(status); }).catch(e => { if (generation.current === epoch) setError(String(e instanceof Error ? e.message : e)); });
    void get('author.read').then(config => { if (generation.current === epoch) applyAuthor(config); }).catch(e => { if (generation.current === epoch) setError(String(e instanceof Error ? e.message : e)); });
    return () => { generation.current++; };
  }, [client, projectId]);
  useEffect(() => {
    const operation = snapshot?.operation;
    if (!operation || !['queued', 'running', 'pausing', 'cancelling'].includes(operation.state)) return;
    const epoch = generation.current;
    let reading = false;
    const timer = window.setInterval(() => { if (reading) return; reading = true; const serial = ++statusSerial.current; void get('status', { operation_id: operation.id }).then(next => { if (generation.current === epoch && statusSerial.current === serial) setSnapshot(next); }).catch(e => { if (generation.current === epoch && statusSerial.current === serial) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { reading = false; }); }, 3000);
    return () => window.clearInterval(timer);
  }, [client, projectId, snapshot?.operation?.id, snapshot?.operation?.state]);
  const run = async (action: () => Promise<void>) => { if (busy) return; ++statusSerial.current; const epoch = generation.current; setBusy(true); setError(''); try { await action(); } catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : String(e)); } finally { if (generation.current === epoch) setBusy(false); } };
  const refresh = async () => { const serial = ++statusSerial.current; const epoch = generation.current; const next = await get('status', snapshot?.operation ? { operation_id: snapshot.operation.id } : {}); if (generation.current === epoch && statusSerial.current === serial) setSnapshot(next); };
  const save = () => run(async () => { if (!author) return; const decoded = author.mode === 'pages' ? JSON.parse(pages) : []; const decodedNotes = JSON.parse(notes); if (!Array.isArray(decoded) || !Array.isArray(decodedNotes)) throw new Error('页面清单和作者说明必须是 JSON 数组'); const next = await get('author.save', { expected_revision: author.revision, expected_storage_token: author.storage_token ?? '', author: { ...author, constraints: constraints.split('\n').filter(Boolean), notes: decodedNotes, pages: author.mode === 'pages' ? decoded : [] } }); applyAuthor(next); });
  const prepare = (intent: NativeIntent) => run(async () => {
    if (dirty) throw new Error('请先保存作者配置，再确认生成');
    const limit = (value: string) => { if (!value.trim()) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error('费用上限必须是非负整数'); return number; };
    const max_model_requests = limit(requestLimit), max_total_tokens = limit(tokenLimit);
    const operation_id = ['repair','resume'].includes(intent) ? snapshot?.operation?.id : undefined;
    const value = await get('prepare', { intent, ...(operation_id ? { operation_id } : { spending_policy: { ...(max_model_requests !== undefined ? { max_model_requests } : {}), ...(max_total_tokens !== undefined ? { max_total_tokens } : {}) } }) });
    requestId.current = crypto.randomUUID(); setConfirmation(value);
  });
  const start = () => run(async () => { if (!confirmation) return; await get('start', { confirmation_id: confirmation.confirmation_id, request_id: requestId.current, confirm_external: true }); setConfirmation(null); await refresh(); });
  const control = (action: 'pause' | 'cancel') => run(async () => { const op = snapshot?.operation; if (!op) return; await get('control', { operation_id: op.id, expected_revision: op.revision, action }); await refresh(); });
  const close = () => { if (dirty && !window.confirm('作者配置有未保存修改，确定离开？')) return; onClose(); };
  const active = snapshot?.operation && ['queued','running','pausing','cancelling'].includes(snapshot.operation.state);
  return <section className="native-wiki-panel" aria-label="原版 Wiki 生成" style={{ position:'absolute', inset:0, zIndex:30, overflow:'auto', background:'var(--rw-bg)', color:'var(--rw-text)', padding:'24px' }}>
    <header style={{display:'flex',alignItems:'center',gap:12}}><h2 style={{margin:0,flex:1}}>原版 Wiki 生成</h2><button className="button" aria-label="返回文档" onClick={close}>返回文档</button></header>
    <p>本地参考内核 · 显式确认后才会调用系统模型。旧 Wiki 和知识卡片继续使用原有流程。</p>
    {error && <p role="alert">{error}</p>}
    <div role="status" aria-label="原版生成状态">
      <strong>{snapshot?.engine ?? '正在读取…'}</strong>{snapshot && !snapshot.executionEnabled && <span> · 执行已停用</span>}
      {snapshot?.operation && <p>运行：{snapshot.operation.state}{snapshot.operation.stage ? ` · ${snapshot.operation.stage}` : ''}{snapshot.operation.error ? ` · ${snapshot.operation.error}` : ''}</p>}
      {snapshot?.publication ? <p>已发布 {snapshot.publication.published_count} 篇 · 失败 {snapshot.publication.failed_count} 篇 · {snapshot.publication.partial ? '部分覆盖' : '完整覆盖'}{snapshot.publication.readable_count !== undefined ? ` · 可阅读 ${snapshot.publication.readable_count} 篇（含保留旧文）` : ''}</p> : <p>已发布 0 篇</p>}
      {!!snapshot?.publication?.failed_items.length && <p>失败项：{snapshot.publication.failed_items.join('、')}</p>}
      {snapshot?.projection && <p>文件投影：{snapshot.projection.status}{snapshot.projection.error ? ` · ${snapshot.projection.error}` : ''}</p>}
      {snapshot?.accounting && <p>业务处理中 {snapshot.accounting.activeSessions} 项 · 等待模型槽 {snapshot.accounting.waiting} 次 · Provider 调用中 {snapshot.accounting.inFlight} 次 · 累计工具调用 {snapshot.accounting.toolsStarted} 次 · 用量未知 {snapshot.accounting.unknown} 次</p>}
    </div>
    <fieldset disabled={busy || !!active}><legend>独立费用限制（新任务；空白表示不限）</legend><label>模型请求次数 <input aria-label="模型请求上限" inputMode="numeric" value={requestLimit} onChange={e => { setRequestLimit(e.target.value); setConfirmation(null); }} /></label> <label>累计 Token <input aria-label="累计 Token 上限" inputMode="numeric" value={tokenLimit} onChange={e => { setTokenLimit(e.target.value); setConfirmation(null); }} /></label><p>修复和继续沿用原任务上限及已用量；每次调用先保守预留上下文与输出，实际用量返回后结算。</p></fieldset>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',margin:'12px 0'}}>
      <button className="button" disabled={busy} onClick={() => void run(refresh)}>刷新状态</button>
      {(['full','update','sync','regenerate','repair','resume'] as const).map(intent => <button className="button" key={intent} data-native-intent={intent} disabled={busy || !snapshot?.executionEnabled || (intent === 'resume' ? !snapshot.operation?.recoverable : !!active) || (['repair','resume'].includes(intent) && !snapshot?.operation)} onClick={() => void prepare(intent)}>{({full:'首次生成',update:'增量更新',sync:'同步',regenerate:'重新生成',repair:'修复失败项',resume:'继续运行'})[intent]}</button>)}
      {active && <><button className="button" aria-label="暂停原版运行" disabled={busy} onClick={() => void control('pause')}>暂停</button><button className="button" disabled={busy} onClick={() => void control('cancel')}>取消运行</button></>}
      {snapshot?.operation?.state === 'paused' && <button className="button" disabled={busy} onClick={() => void control('cancel')}>取消运行</button>}
      {snapshot?.projection && snapshot.projection.status !== 'ready' && <button className="button" disabled={busy} onClick={() => void run(async () => { await get('projection.repair', { publication_id: snapshot.projection!.publication_id }); await refresh(); })}>修复文件投影</button>}
      {snapshot?.operation && <button className="button" disabled={busy} onClick={() => void run(async () => { setDrafts((await get('drafts', { operation_id: snapshot.operation!.id })).items); })}>查看阶段正文</button>}
    </div>
    {confirmation && <section aria-label="确认外发模型"><h3>确认生成</h3><p>模型：{confirmation.model_identity} · 分支：{confirmation.branch} · 提交：{confirmation.target_commit}</p><p>有效上下文：{confirmation.effective_profile?.context_window ?? '参考默认'}；最大输出：{confirmation.effective_profile?.max_output_tokens ?? '参考默认'}</p><p>作者版本：{confirmation.author_revision} · 范围：{JSON.stringify(confirmation.scope)}</p><p>将发送范围内源码，产生模型费用；请求上限：{confirmation.spending_policy?.max_model_requests ?? '不限'}；累计 Token 上限：{confirmation.spending_policy?.max_total_tokens ?? '不限'}。同步超出增量阈值时允许全量生成；恢复中断会话可能重读源码，已用量保留。</p><button className="button primary" aria-label="确认外发并开始" disabled={busy} onClick={() => void start()}>确认外发并开始</button> <button className="button" onClick={() => setConfirmation(null)}>取消</button></section>}
    {author && <section aria-label="原版作者配置"><h3>作者配置</h3><label>模式 <select disabled={busy} value={author.mode} onChange={e => { setAuthor({ ...author, mode: e.target.value as NativeAuthor['mode'] }); setDirty(true); setConfirmation(null); }}><option value="auto">自动规划</option><option value="pages">指定页面</option></select></label>
      <label style={{display:'block',marginTop:12}}>约束（每行一项）<textarea disabled={busy} aria-label="作者约束" value={constraints} onChange={e => {setConstraints(e.target.value);setDirty(true);setConfirmation(null);}} rows={3} style={{display:'block',width:'100%'}} /></label>
      <label style={{display:'block',marginTop:12}}>作者说明（JSON：Text、可选 Author）<textarea disabled={busy} aria-label="作者说明" value={notes} onChange={e => {setNotes(e.target.value);setDirty(true);setConfirmation(null);}} rows={3} style={{display:'block',width:'100%'}} /></label>
      {author.mode === 'pages' && <label style={{display:'block',marginTop:12}}>页面清单（JSON：id、title、prompt，可选 template、children）<textarea disabled={busy} aria-label="作者页面清单" value={pages} onChange={e => {setPages(e.target.value);setDirty(true);setConfirmation(null);}} rows={8} style={{display:'block',width:'100%',fontFamily:'monospace'}} /></label>}
      <div style={{display:'flex',gap:8,marginTop:12}}><button className="button primary" aria-label="保存作者配置" disabled={busy || (!dirty && author.revision > 0)} onClick={() => void save()}>保存作者配置</button><button className="button" aria-label="显式转换旧计划" disabled={busy || dirty} onClick={() => void run(async () => { const result = await get('author.convert', { expected_revision: author.revision, expected_storage_token: author.storage_token ?? '' }); applyAuthor(result.author); setDirty(true); setError(result.dropped_depends_on.length ? `旧页面依赖不参与新内核：${result.dropped_depends_on.join('、')}` : '已转换，请检查并确认配置'); })}>显式转换旧计划</button></div>
    </section>}
    {drafts.length > 0 && <section aria-label="阶段正文"><h3>阶段正文</h3>{drafts.map(draft => <details key={draft.id}><summary>{draft.title}</summary><pre style={{whiteSpace:'pre-wrap'}}>{draft.markdown}</pre></details>)}</section>}
  </section>;
}
