import { Fragment, useEffect, useRef, useState } from 'react';
import type { ManagedMemoryRecord, MemoryConversationDetail } from '../../lib/agentData';
import { pi, type SessionInfo } from '../../lib/pi';
import { findSourceSession, memoryLevelLabels, sourceSessionId } from './memoryPresentation';
import { memoryStyles as m } from './memoryStyles';
import { styles } from './agentDataStyles';
export interface MemoryDetailProps {
  value: { kind: 'memory'; record: ManagedMemoryRecord } | { kind: 'conversation'; record: MemoryConversationDetail };
  visible?: boolean;
  onEdit?(): void; onDelete?(): void; onOpenSession?(cwd: string, path: string): void | Promise<void>;
}
function StructuredContent({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ol>{value.map((item, index) => <li key={index}><StructuredContent value={item} /></li>)}</ol>;
  if (value !== null && typeof value === 'object') return <dl>{Object.entries(value).map(([key, item]) => <Fragment key={key}><dt>{key}</dt><dd><StructuredContent value={item} /></dd></Fragment>)}</dl>;
  return <span>{value === null ? 'null' : String(value)}</span>;
}

function MemoryContent({ content }: { content: string }) {
  try {
    const parsed: unknown = JSON.parse(content);
    return <><StructuredContent value={parsed} /><details><summary>原始 JSON</summary><pre>{content}</pre></details></>;
  } catch { return <pre>{content}</pre>; }
}

export function MemoryDetail({ value, visible = true, onEdit, onDelete, onOpenSession }: MemoryDetailProps) {
  const source = value.kind === 'memory' ? value.record : { ...value.record, sourceWorkspace: value.record.workspace };
  const id = sourceSessionId(source);
  const key = JSON.stringify([value.kind, value.record.id, id, source.sourceWorkspace, source.source]);
  const current = useRef({ key, visible, epoch: 0, busy: false });
  if (current.current.key !== key || current.current.visible !== visible) current.current = { key, visible, epoch: current.current.epoch + 1, busy: false };
  const [lookup, setLookup] = useState<{ key: string; state: 'loading' | 'ready' | 'error'; session?: SessionInfo }>({ key, state: 'loading' });
  const [opening, setOpening] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const runtime = current.current;
    const epoch = ++runtime.epoch;
    const isCurrent = () => current.current === runtime && runtime.epoch === epoch;
    if (!visible) return;
    setOpening(false);
    setLookup({ key, state: 'loading' });
    if (id) void pi.listAllSessions().then((sessions) => {
      if (isCurrent()) setLookup({ key, state: 'ready', session: findSourceSession(source, sessions) });
    }).catch(() => { if (isCurrent()) setLookup({ key, state: 'error' }); });
    return () => { runtime.epoch++; };
  }, [key, visible, retry]);
  const open = async () => {
    const runtime = current.current;
    if (!visible || !onOpenSession || runtime.busy) return;
    const epoch = ++runtime.epoch;
    const isCurrent = () => current.current === runtime && runtime.epoch === epoch;
    runtime.busy = true; setOpening(true);
    try {
      const session = findSourceSession(source, await pi.listAllSessions());
      if (!isCurrent()) return;
      setLookup({ key, state: 'ready', session });
      if (session?.cwd) await onOpenSession(session.cwd, session.path);
    } catch { if (isCurrent()) setLookup({ key, state: 'error' }); }
    finally { if (isCurrent()) { runtime.busy = false; setOpening(false); } }
  };
  const status = lookup.key === key ? lookup : { key, state: 'loading' as const };
  return <article className={m.document} aria-label={value.kind === 'memory' ? '记忆详情' : '对话记录详情'}>
    <div className={m.toolbar}>
      <h4 className={m.heading}>{value.kind === 'memory' ? memoryLevelLabels[value.record.level] : '对话记录 · 只读'}</h4>
      {value.kind === 'memory' && onEdit ? <button data-memory-edit className={m.button} type="button" onClick={onEdit}>编辑记忆</button> : null}
      {value.kind === 'memory' && onDelete ? <button className={`${m.button} ${m.danger}`} type="button" onClick={onDelete}>删除记忆</button> : null}
    </div>
    <div className={m.meta}>
      <span>更新时间：{new Date(value.record.updatedAt).toLocaleString()}</span>
      <span>归属：{value.kind === 'memory' ? value.record.scope === 'global' ? '全局' : value.record.sourceProjectId : value.record.workspace}</span>
      {value.kind === 'memory' ? <span>版本 r{value.record.revision} · {value.record.origin === 'manual' ? '人工记忆' : '自动提炼'}</span> : null}
    </div>
    {value.kind === 'memory' ? <MemoryContent content={value.record.content} /> : <><h5>命中片段</h5><p>{value.record.snippet}</p><h5>完整对话</h5><pre>{value.record.transcript}</pre></>}
    <hr className={m.divider} /><h5>来源</h5>
    {!id ? <p>{source.source || '未记录来源'}</p> : status.state === 'error' ? <div><p className={styles.inlineError} role="alert">来源状态未获取</p><button type="button" className={m.button} onClick={() => setRetry((version) => version + 1)}>重试来源查询</button></div>
      : status.state === 'loading' ? <p role="status">正在核对来源会话…</p>
      : status.session ? <div><p>{status.session.name ?? status.session.id}</p><p className={m.meta}>{status.session.cwd}</p>{onOpenSession ? <button type="button" className={m.button} onClick={() => void open()} disabled={opening}>打开来源会话</button> : null}</div>
      : <p>会话已移除</p>}
  </article>;
}
