import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Divider, Dropdown, Flex, Input, Segmented, Select, Typography } from 'antd';
import { AlertTriangle, CheckCircle2, LoaderCircle, MoreHorizontal, PauseCircle, RefreshCw, Settings2 } from 'lucide-react';
import type { NativeAuthor, NativeConfirmation, NativeIntent, NativeRequest, NativeResponse, NativeSnapshot, RepoWikiClient } from '../../../../packages/contracts/src/index';
import { Icon } from './Icons';
import './collection.css';
import './native-wiki.css';

const intentLabels: Record<NativeIntent, string> = { full: '首次生成', update: '增量更新', sync: '同步', regenerate: '重新生成', repair: '修复失败项', resume: '继续运行' };
const stateLabels: Record<string, string> = { queued: '等待生成', running: '正在生成', pausing: '正在暂停', paused: '已暂停', cancelling: '正在取消', cancelled: '已取消', failed: '生成失败', completed: '已生成' };
const projectionLabels = { pending: '待写入文件', ready: '已写入文件', conflict: '文件存在冲突', error: '文件写入失败' };

type Props = { client: RepoWikiClient; projectId: string; onClose?: () => void; variant?: 'overlay' | 'overview'; language?: string; onLanguage?: (language: string) => void; onLegacyDrafts?: () => void; onPublicationChange?: () => void; visible?: boolean };
export function NativeWikiPanel({ client, projectId, onClose, variant = 'overlay', language, onLanguage, onLegacyDrafts, onPublicationChange, visible = true }: Props) {
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
  const publicationCallback = useRef(onPublicationChange);
  publicationCallback.current = onPublicationChange;
  const publicationKey = JSON.stringify([snapshot?.publication, snapshot?.projection]);
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
    const serial = ++statusSerial.current;
    void get('status').then(status => { if (generation.current === epoch && statusSerial.current === serial) setSnapshot(status); }).catch(e => { if (generation.current === epoch && statusSerial.current === serial) setError(String(e instanceof Error ? e.message : e)); });
    void get('author.read').then(config => { if (generation.current === epoch) applyAuthor(config); }).catch(e => { if (generation.current === epoch) setError(String(e instanceof Error ? e.message : e)); });
    return () => { generation.current++; };
  }, [client, projectId]);
  useEffect(() => {
    const operation = snapshot?.operation;
    if (!visible || !operation || !['queued', 'running', 'pausing', 'cancelling'].includes(operation.state)) return;
    const epoch = generation.current;
    let reading = false;
    const timer = window.setInterval(() => { if (reading) return; reading = true; const serial = ++statusSerial.current; void get('status').then(next => { if (generation.current === epoch && statusSerial.current === serial) setSnapshot(next); }).catch(e => { if (generation.current === epoch && statusSerial.current === serial) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { reading = false; }); }, 3000);
    return () => window.clearInterval(timer);
  }, [client, projectId, snapshot?.operation?.id, snapshot?.operation?.state, visible]);
  useEffect(() => { if (snapshot?.publication || snapshot?.projection) publicationCallback.current?.(); }, [publicationKey]);
  const run = async (action: () => Promise<void>) => { if (busy) return; ++statusSerial.current; const epoch = generation.current; setBusy(true); setError(''); try { await action(); } catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : String(e)); } finally { if (generation.current === epoch) setBusy(false); } };
  const refresh = async (operationId?: string) => { const serial = ++statusSerial.current; const epoch = generation.current; const next = await get('status', operationId ? { operation_id: operationId } : {}); if (generation.current === epoch && statusSerial.current === serial) setSnapshot(next); };
  const save = () => run(async () => { if (!author) return; const decoded = author.mode === 'pages' ? JSON.parse(pages) : []; const decodedNotes = JSON.parse(notes); if (!Array.isArray(decoded) || !Array.isArray(decodedNotes)) throw new Error('页面清单和作者说明必须是 JSON 数组'); const next = await get('author.save', { expected_revision: author.revision, expected_storage_token: author.storage_token ?? '', author: { ...author, constraints: constraints.split('\n').filter(Boolean), notes: decodedNotes, pages: author.mode === 'pages' ? decoded : [] } }); applyAuthor(next); });
  const prepare = (intent: NativeIntent) => run(async () => {
    if (dirty) throw new Error('请先保存作者配置，再确认生成');
    if (!author) throw new Error('作者配置尚未加载');
    if (author.revision === 0 && !['repair', 'resume'].includes(intent)) {
      const saved = await get('author.save', { expected_revision: author.revision, expected_storage_token: author.storage_token ?? '', author });
      applyAuthor(saved);
    }
    const limit = (value: string) => { if (!value.trim()) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error('费用上限必须是非负整数'); return number; };
    const max_model_requests = limit(requestLimit), max_total_tokens = limit(tokenLimit);
    const operation_id = ['repair','resume'].includes(intent) ? snapshot?.operation?.id : undefined;
    const value = await get('prepare', { intent, ...(operation_id ? { operation_id } : { spending_policy: { ...(max_model_requests !== undefined ? { max_model_requests } : {}), ...(max_total_tokens !== undefined ? { max_total_tokens } : {}) } }) });
    requestId.current = crypto.randomUUID(); setConfirmation(value);
  });
  const start = () => run(async () => { if (!confirmation) return; const operation = await get('start', { confirmation_id: confirmation.confirmation_id, request_id: requestId.current, confirm_external: true }); setSnapshot(previous => previous ? { ...previous, operation } : previous); setConfirmation(null); await refresh(); });
  const control = (action: 'pause' | 'cancel') => run(async () => { const op = snapshot?.operation; if (!op) return; await get('control', { operation_id: op.id, expected_revision: op.revision, action }); await refresh(); });
  const close = () => { if (dirty && !window.confirm('作者配置有未保存修改，确定离开？')) return; onClose?.(); };
  const operation = snapshot?.operation;
  const active = !!operation && ['queued', 'running', 'pausing', 'cancelling'].includes(operation.state);
  const recoverable = !!operation?.recoverable;
  const repairable = !!operation && (operation.state === 'failed' || operation.state === 'completed' && !!snapshot?.publication?.partial);
  const primaryIntent: NativeIntent = recoverable ? 'resume' : repairable ? 'repair' : snapshot?.publication ? 'update' : 'full';
  const disabledIntent = (intent: NativeIntent) => busy || !author || !snapshot?.executionEnabled ||
    (intent === 'resume' ? !recoverable : active) || (intent === 'repair' && !repairable);
  const languageValue = (language ?? author?.locale)?.toLowerCase().startsWith('en') ? 'en' : 'zh';
  const status = !snapshot ? '正在读取…' : !snapshot.executionEnabled ? '执行已停用' : operation ?
    operation.state === 'completed' && snapshot.publication?.partial ? '部分生成' : stateLabels[operation.state] ?? operation.state : snapshot.publication ? '已生成' : '未生成';
  const statusTone = operation?.state === 'failed' ? 'failed' : snapshot?.publication?.partial ? 'partial' : snapshot?.publication ? 'completed' : 'pending';
  const row = (label: string, value: ReactNode) => <Flex className="rw-state-row" justify="space-between" align="center" gap={16}>
    <Typography.Text type="secondary">{label}</Typography.Text><span className="rw-state-value">{value}</span>
  </Flex>;
  const statusIcon = active ? <LoaderCircle size={14} className="rw-spin" aria-hidden="true" /> : operation?.state === 'paused' ? <PauseCircle size={14} aria-hidden="true" /> :
    statusTone === 'failed' || statusTone === 'partial' ? <AlertTriangle size={14} aria-hidden="true" /> : snapshot?.publication ? <CheckCircle2 size={14} aria-hidden="true" /> : null;
  const moreMenu = {
    items: (Object.keys(intentLabels) as NativeIntent[]).filter(intent => intent !== primaryIntent).map(intent => ({
      key: intent, label: <span data-native-intent={intent}>{intentLabels[intent]}</span>, disabled: disabledIntent(intent),
    })),
    onClick: ({ key }: { key: string }) => { void prepare(key as NativeIntent); },
  };
  return <section className={'rw-generation-overview native-wiki-panel native-wiki-panel--' + variant} data-native-variant={variant} aria-label={variant === 'overview' ? 'Repo Wiki 概览' : '原版 Wiki 生成'}>
    {onClose && <Button className="native-wiki-back" type="text" aria-label="返回文档" onClick={close}>返回文档</Button>}
    <div className="rw-overview-cluster">
      <div className="rw-overview-emblem" aria-hidden="true"><span className="rw-overview-mark"><Icon name="branch" size={25} /></span></div>
      <h1>Repo Wiki 概览</h1>
      <Flex vertical gap={14} className="rw-state-stack">
        <div className="rw-state-card" role="status" aria-label="原版生成状态" data-engine={snapshot?.engine}>
          <Flex className="rw-state-row" justify="space-between" align="center" gap={12}>
            <Typography.Text strong>语言</Typography.Text>
            <Flex align="center" gap={6}>
              {onLanguage ? <Segmented className="rw-language-switch" aria-label="生成语言" size="small" value={languageValue}
                disabled={busy || active} onChange={value => onLanguage(String(value))}
                options={[{ label: 'English', value: 'en' }, { label: '简体中文', value: 'zh' }]} /> : <Typography.Text>{languageValue === 'en' ? 'English' : '简体中文'}</Typography.Text>}
              <Button type="text" size="small" icon={<RefreshCw size={14} aria-hidden="true" />} aria-label="刷新原生状态" title="刷新状态" disabled={busy} onClick={() => void run(() => refresh())} />
            </Flex>
          </Flex>
          <Divider className="rw-state-divider" />
          {row('生成状态', <span className="rw-state-status" data-status={statusTone}>{statusIcon}{status}</span>)}
          {row('Wiki 文件', snapshot?.publication ? '已发布 ' + snapshot.publication.published_count + ' 篇 · 失败 ' + snapshot.publication.failed_count + ' 篇' : '已发布 0 篇')}
          {snapshot?.publication && row('内容覆盖', snapshot.publication.partial ? '部分覆盖' : '完整覆盖')}
          {snapshot?.publication?.readable_count !== undefined && row('可阅读', snapshot.publication.readable_count + ' 篇（含保留旧文）')}
          {snapshot?.projection && row('文件投影', projectionLabels[snapshot.projection.status])}
          {operation?.stage && row('当前阶段', operation.stage)}
          {active && snapshot?.accounting && <Typography.Text className="rw-run-description" type="secondary">处理中 {snapshot.accounting.activeSessions} 项 · 等待模型 {snapshot.accounting.waiting} 次 · 调用中 {snapshot.accounting.inFlight} 次</Typography.Text>}
        </div>
        {(error || operation?.error || snapshot?.projection?.error) && <div className="native-wiki-error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{error || operation?.error || snapshot?.projection?.error}</span></div>}
        {active && <Typography.Text className="rw-state-hint" type="secondary">后台运行，离开页面不影响生成。</Typography.Text>}
        {confirmation ? <section className="native-wiki-confirm" aria-label="确认外发模型">
          <h2>{intentLabels[confirmation.intent]}</h2>
          <p>将发送范围内源码并调用系统模型，产生模型费用。</p>
          <dl className="native-wiki-details">
            <div><dt>引擎</dt><dd><code>qoder-wiki-local-v1</code></dd></div>
            <div><dt>模型</dt><dd>{confirmation.model_identity}</dd></div>
            <div><dt>分支</dt><dd>{confirmation.branch}</dd></div>
            <div><dt>目标提交</dt><dd><code>{confirmation.target_commit}</code></dd></div>
            <div><dt>作者版本</dt><dd>{confirmation.author_revision}</dd></div>
            <div><dt>有效上下文</dt><dd>{confirmation.effective_profile?.context_window ?? '参考默认'}</dd></div>
            <div><dt>最大输出</dt><dd>{confirmation.effective_profile?.max_output_tokens ?? '参考默认'}</dd></div>
            <div><dt>模型请求上限</dt><dd>{confirmation.spending_policy?.max_model_requests ?? '不限'}</dd></div>
            <div><dt>累计 Token 上限</dt><dd>{confirmation.spending_policy?.max_total_tokens ?? '不限'}</dd></div>
          </dl>
          <details><summary>查看源码范围</summary><pre>{JSON.stringify(confirmation.scope, null, 2)}</pre></details>
          {confirmation.intent === 'sync' && <p>超出增量阈值时允许全量生成。</p>}
          {['resume', 'repair'].includes(confirmation.intent) && <p>保留已用量与原任务上限；恢复中断会话可能重读源码。</p>}
          <Flex gap={8} className="native-wiki-confirm-actions"><Button type="primary" aria-label="确认外发并开始" disabled={busy} onClick={() => void start()}>确认外发并开始</Button><Button disabled={busy} onClick={() => setConfirmation(null)}>取消</Button></Flex>
        </section> : active && !recoverable ? <Flex gap={8} className="native-wiki-primary rw-run-actions middle">
          <Button type="primary" aria-label="暂停原版运行" disabled={busy || ['pausing', 'cancelling'].includes(operation!.state)} onClick={() => void control('pause')}>{operation?.state === 'pausing' ? '正在暂停…' : operation?.state === 'cancelling' ? '正在取消…' : '暂停'}</Button>
          <Button aria-label="取消原生运行" disabled={busy || operation?.state === 'cancelling'} onClick={() => void control('cancel')}>取消运行</Button>
        </Flex> : <div className="native-wiki-primary rw-generate-group">
          <Button type="primary" data-native-intent={primaryIntent} disabled={disabledIntent(primaryIntent)} onClick={() => void prepare(primaryIntent)}>{intentLabels[primaryIntent]}</Button>
          <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight"><Button type="primary" aria-label="更多生成操作" disabled={busy} icon={<MoreHorizontal size={15} aria-hidden="true" />} /></Dropdown>
        </div>}
        {!confirmation && operation?.state === 'paused' && <Button aria-label="取消原生运行" disabled={busy} onClick={() => void control('cancel')}>取消运行</Button>}
        {snapshot?.projection && snapshot.projection.status !== 'ready' && <Button disabled={busy} onClick={() => void run(async () => { await get('projection.repair', { publication_id: snapshot.projection!.publication_id }); await refresh(); })}>修复文件投影</Button>}
        <Flex justify="center" wrap gap={4} className="native-wiki-links">
          {operation && <Button type="link" size="small" disabled={busy} onClick={() => void run(async () => { setDrafts((await get('drafts', { operation_id: operation.id })).items); })}>查看阶段正文</Button>}
          {onLegacyDrafts && <Button type="link" size="small" aria-label="查看旧引擎历史草稿" onClick={onLegacyDrafts}>查看旧引擎历史草稿</Button>}
        </Flex>
        <Typography.Text type="secondary" className="rw-generation-mode-note">系统知识模型 · 确认后发送源码，可能产生费用</Typography.Text>
        <details className="native-wiki-settings" aria-label="生成设置"><summary><Settings2 size={14} aria-hidden="true" />生成设置{dirty && <span className="native-wiki-unsaved">未保存</span>}</summary>
          <div className="native-wiki-settings-body">
            <section className="native-wiki-budget" aria-label="新任务费用上限"><h2>费用上限</h2>
              <Typography.Text type="secondary">留空不设累计上限；修复和继续沿用原上限及已用量。</Typography.Text>
              <div className="native-wiki-fields">
                <label>模型请求次数<Input aria-label="模型请求上限" placeholder="不限" inputMode="numeric" disabled={busy || active} value={requestLimit} onChange={e => { setRequestLimit(e.target.value); setConfirmation(null); }} /></label>
                <label>累计 Token<Input aria-label="累计 Token 上限" placeholder="不限" inputMode="numeric" disabled={busy || active} value={tokenLimit} onChange={e => { setTokenLimit(e.target.value); setConfirmation(null); }} /></label>
              </div>
            </section>
            {author && <details className="native-wiki-author" aria-label="原版作者配置"><summary>作者配置{dirty ? ' · 未保存' : ''}</summary>
              <div className="native-wiki-settings-body">
                <label className="native-wiki-field">规划模式<Select<NativeAuthor['mode']> aria-label="作者规划模式" disabled={busy} value={author.mode} onChange={value => { setAuthor({ ...author, mode: value }); setDirty(true); setConfirmation(null); }} options={[{ value: 'auto', label: '自动规划' }, { value: 'pages', label: '指定页面' }]} /></label>
                <label className="native-wiki-field">约束（每行一项）<Input.TextArea disabled={busy} aria-label="作者约束" value={constraints} onChange={e => { setConstraints(e.target.value); setDirty(true); setConfirmation(null); }} rows={3} /></label>
                <label className="native-wiki-field">作者说明（JSON：Text、可选 Author）<Input.TextArea disabled={busy} aria-label="作者说明" value={notes} onChange={e => { setNotes(e.target.value); setDirty(true); setConfirmation(null); }} rows={3} /></label>
                {author.mode === 'pages' && <label className="native-wiki-field">页面清单（JSON：id、title、prompt，可选 template、children）<Input.TextArea disabled={busy} aria-label="作者页面清单" value={pages} onChange={e => { setPages(e.target.value); setDirty(true); setConfirmation(null); }} rows={8} /></label>}
                <Flex gap={8} wrap><Button type="primary" aria-label="保存作者配置" disabled={busy || (!dirty && author.revision > 0)} onClick={() => void save()}>保存作者配置</Button><Button aria-label="显式转换旧计划" disabled={busy || dirty} onClick={() => void run(async () => { const result = await get('author.convert', { expected_revision: author.revision, expected_storage_token: author.storage_token ?? '' }); applyAuthor(result.author); setDirty(true); setError(result.dropped_depends_on.length ? '旧页面依赖不参与新内核：' + result.dropped_depends_on.join('、') : '已转换，请检查并确认配置'); })}>显式转换旧计划</Button></Flex>
              </div>
            </details>}
            <details className="native-wiki-diagnostics"><summary>运行详情</summary><dl className="native-wiki-details">
              <div><dt>引擎</dt><dd><code>{snapshot?.engine ?? '正在读取…'}</code></dd></div>
              {operation && <><div><dt>操作 ID</dt><dd><code>{operation.id}</code></dd></div><div><dt>修订</dt><dd>{operation.revision}</dd></div></>}
              {!!snapshot?.publication?.failed_items.length && <div><dt>失败项</dt><dd>{snapshot.publication.failed_items.join('、')}</dd></div>}
              {snapshot?.accounting && <><div><dt>工具调用</dt><dd>{snapshot.accounting.toolsStarted}</dd></div><div><dt>用量未知</dt><dd>{snapshot.accounting.unknown}</dd></div></>}
            </dl></details>
          </div>
        </details>
        {drafts.length > 0 && <section className="native-wiki-drafts" aria-label="阶段正文"><h2>阶段正文</h2>{drafts.map(draft => <details key={draft.id}><summary>{draft.title}</summary><pre>{draft.markdown}</pre></details>)}</section>}
      </Flex>
    </div>
  </section>;
}
