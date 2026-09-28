import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Modal, Typography } from 'antd';
import { agentDataApi, type WikiAssetDetail } from '../../../lib/agentData';
import { openPath } from '../../../platform/runtime';
import { PageHeader } from '../workbench/PageHeader';
import { MoreMenu } from '../workbench/MoreMenu';
import { StatusTag } from '../workbench/StatusTag';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { wikiStyles as w } from './wikiStyles';

interface Props { visible: boolean; onOpen(wikiId: string): void; refreshVersion: number; refreshToken?: number; onBeforeDelete?(wikiId: string): Promise<boolean>; onDeleted?(wikiId: string): void }

export function WikiLibraryList({ visible, onOpen, refreshVersion, refreshToken = 0, onBeforeDelete, onDeleted }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<WikiAssetDetail[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<{ library?: WikiAssetDetail }>();
  const [deleteTarget, setDeleteTarget] = useState<WikiAssetDetail>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [confirmName, setConfirmName] = useState('');
  const sequence = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const request = ++sequence.current;
    if (!visible) return;
    setLoading(true);
    void agentDataApi.wiki.list()
      .then((next) => {
        if (sequence.current !== request) return;
        const filtered = debounced
          ? next.filter((row) => `${row.name} ${row.summary ?? ''}`.toLowerCase().includes(debounced.toLowerCase()))
          : next;
        setRows(filtered);
        setError(undefined);
        setLoaded(true);
      })
      .catch((cause) => { if (sequence.current === request) setError(String(cause)); })
      .finally(() => { if (sequence.current === request) setLoading(false); });
    return () => { sequence.current++; };
  }, [visible, debounced, refreshVersion, refreshToken, refresh]);
  const sorted = useMemo(() => [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [rows]);
  const filtered = !!debounced;

  const confirmDelete = async () => {
    if (!deleteTarget || deleting || confirmName !== deleteTarget.name) return;
    setDeleting(true); setDeleteError(undefined);
    try {
      await agentDataApi.wiki.remove(deleteTarget.wikiId);
      setDeleteTarget(undefined);
      setRefresh((value) => value + 1);
      onDeleted?.(deleteTarget.wikiId);
    } catch (cause) { setDeleteError(String(cause)); }
    finally { setDeleting(false); }
  };

  return <section className={w.root} hidden={!visible} aria-label="知识库列表">
    <PageHeader title="知识库" subtitle={`${rows.length} 个`} actions={<>
      <Input aria-label="搜索知识库" placeholder="搜索名称或用途" value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: 200 }} />
      <Button type="primary" onClick={() => setDialog({})}>新建知识库</Button>
    </>} />
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {!loaded && loading ? <Typography.Text type="secondary" role="status">正在加载知识库…</Typography.Text> : null}
    {loaded && !rows.length ? <Empty description={filtered ? '没有匹配知识库' : '还没有知识库，从新建知识库开始。'} /> : null}
    <div className={w.list} aria-label="知识库浏览结果">{sorted.map((row) => <Card key={row.wikiId} hoverable tabIndex={0} aria-label={`知识库 ${row.name}`} onClick={() => onOpen(row.wikiId)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(row.wikiId); } }}>
      <div className={w.libraryHeader}>
        <Button type="link" aria-label={`打开知识库 ${row.name}`} onClick={(event) => { event.stopPropagation(); onOpen(row.wikiId); }}>{row.name}</Button>
        <MoreMenu label={`知识库 ${row.name} 更多操作`} items={[{ key: 'props', label: '属性' }, { key: 'open', label: '打开存储位置' }, { key: 'delete', label: '删除知识库', danger: true }]}
          onSelect={async (key) => {
            if (key === 'props') setDialog({ library: row });
            if (key === 'open') void openPath(row.dir).catch((cause) => setError(String(cause)));
            if (key === 'delete' && (!onBeforeDelete || await onBeforeDelete(row.wikiId))) { setConfirmName(''); setDeleteError(undefined); setDeleteTarget(row); }
          }} />
      </div>
      <Typography.Text type="secondary">{row.summary || '未填写用途'}</Typography.Text>
      <div className={w.libraryMeta}><StatusTag domain="wiki" status={row.status} /><span>{row.pageCount ?? 0} 页 · {row.sourceCount ?? '未知'} 份资料</span></div>
      {row.status === 'failed' && row.syncError ? <Typography.Text type="danger">{row.syncError}</Typography.Text> : null}
    </Card>)}</div>
    <WikiLibraryDialog open={!!dialog} visible={visible} library={dialog?.library} onClose={() => setDialog(undefined)} onSaved={(saved) => { const created = !dialog?.library; setDialog(undefined); setRefresh((value) => value + 1); if (created) onOpen(saved.wikiId); }} />
    <Modal open={!!deleteTarget} title="确认删除知识库" closable={!deleting} keyboard={!deleting} onCancel={() => { if (!deleting) setDeleteTarget(undefined); }} onOk={() => void confirmDelete()} okText="确认删除" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: !deleteTarget || confirmName !== deleteTarget.name, autoInsertSpace: false }}>
      {deleteError ? <Alert type="error" title={deleteError} showIcon /> : null}
      <p>删除后不可恢复。输入知识库名称确认。</p>
      <Input aria-label="输入知识库名称确认" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
    </Modal>
  </section>;
}
