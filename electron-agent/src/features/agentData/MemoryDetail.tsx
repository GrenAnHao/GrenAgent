import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Divider, Listy, Typography } from 'antd';
import type { ManagedMemoryRecord, MemoryConversationDetail } from '../../lib/agentData';
import { pi, type SessionInfo } from '../../lib/pi';
import { findSourceSession, memoryLevelLabels, sourceSessionId } from './memoryPresentation';
import { memoryStyles as m } from './memoryStyles';
export interface MemoryDetailProps {
  value: { kind: 'memory'; record: ManagedMemoryRecord } | { kind: 'conversation'; record: MemoryConversationDetail };
  visible?: boolean;
  onEdit?(): void; onDelete?(): void; onOpenSession?(cwd: string, path: string): void | Promise<void>;
}
function StructuredContent({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <Listy items={value.map((item, index) => ({ item, index }))} rowKey={(entry) => entry.index} itemRender={(entry) => <div role="listitem"><StructuredContent value={entry.item} /></div>} />;
  if (value !== null && typeof value === 'object') return <Descriptions size="small" column={1} items={Object.entries(value).map(([key, item]) => ({ key, label: key, children: <StructuredContent value={item} /> }))} />;
  return <Typography.Text>{value === null ? 'null' : String(value)}</Typography.Text>;
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
      <Typography.Title level={5} style={{ margin: 0 }}>{value.kind === 'memory' ? memoryLevelLabels[value.record.level] : '对话记录 · 只读'}</Typography.Title>
      {value.kind === 'memory' && onEdit ? <Button data-memory-edit onClick={onEdit}>编辑记忆</Button> : null}
      {value.kind === 'memory' && onDelete ? <Button danger onClick={onDelete}>删除记忆</Button> : null}
    </div>
    <div className={m.meta}>
      <Typography.Text type="secondary">更新时间：{new Date(value.record.updatedAt).toLocaleString()}</Typography.Text>
      <Typography.Text type="secondary">归属：{value.kind === 'memory' ? value.record.scope === 'global' ? '全局' : value.record.sourceProjectId : value.record.workspace}</Typography.Text>
      {value.kind === 'memory' ? <Typography.Text type="secondary">版本 r{value.record.revision} · {value.record.origin === 'manual' ? '人工记忆' : '自动提炼'}</Typography.Text> : null}
    </div>
    {value.kind === 'memory' ? <MemoryContent content={value.record.content} /> : <><Typography.Title level={5}>命中片段</Typography.Title><Typography.Paragraph>{value.record.snippet}</Typography.Paragraph><Typography.Title level={5}>完整对话</Typography.Title><pre>{value.record.transcript}</pre></>}
    <Divider /><Typography.Title level={5}>来源</Typography.Title>
    {!id ? <Typography.Paragraph>{source.source || '未记录来源'}</Typography.Paragraph> : status.state === 'error' ? <div><Alert type="error" showIcon title="来源状态未获取" /><Button style={{ marginTop: 8 }} onClick={() => setRetry((version) => version + 1)}>重试来源查询</Button></div>
      : status.state === 'loading' ? <Typography.Paragraph role="status">正在核对来源会话…</Typography.Paragraph>
      : status.session ? <div><Typography.Paragraph>{status.session.name ?? status.session.id}</Typography.Paragraph><Typography.Paragraph type="secondary">{status.session.cwd}</Typography.Paragraph>{onOpenSession ? <Button onClick={() => void open()} disabled={opening}>打开来源会话</Button> : null}</div>
      : <Typography.Paragraph>会话已移除</Typography.Paragraph>}
  </article>;
}
