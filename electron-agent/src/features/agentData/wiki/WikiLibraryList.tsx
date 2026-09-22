import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Modal, Select, Tag, Typography } from 'antd';
import { RefreshCw } from 'lucide-react';
import { agentDataApi, type WikiAssetDetail } from '../../../lib/agentData';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { wikiStyles as w } from './wikiStyles';

interface Props { visible: boolean; onOpen(wikiId: string): void; refreshVersion: number; onBeforeDelete?(wikiId: string): Promise<boolean>; onDeleted?(wikiId: string): void }

const statusLabels: Record<string, string> = {
  draft: '草稿', pending: '待抽取', processing: '处理中', ready: '可用', failed: '失败',
};

export function WikiLibraryList({ visible, onOpen, refreshVersion, onBeforeDelete, onDeleted }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [order, setOrder] = useState('updated');
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
  }, [visible, debounced, refreshVersion, refresh]);
  const sorted = useMemo(() => [...rows].sort((a, b) => order === 'name' ? a.name.localeCompare(b.name, 'zh') : Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [rows, order]);
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
    <header className={w.listHeader}>
      <div><Typography.Title level={5} style={{ margin: 0 }}>知识库</Typography.Title><Typography.Text type="secondary">管理原文、抽取模板与知识页面。</Typography.Text></div>
      <Button type="primary" onClick={() => setDialog({})}>新建知识库</Button>
    </header>
    <div className={w.listToolbar}>
      <Input aria-label="搜索知识库" placeholder="搜索名称或用途" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 180 }} />
      <Select aria-label="知识库排序" value={order} style={{ minWidth: 130 }} onChange={(value) => setOrder(value)} options={[{ value: 'updated', label: '最近更新' }, { value: 'name', label: '名称排序' }]} />
      <Button aria-label="刷新知识库" icon={<RefreshCw size={14} />} disabled={loading} onClick={() => setRefresh((value) => value + 1)} />
    </div>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {!loaded && loading ? <Typography.Text type="secondary" role="status">正在加载知识库…</Typography.Text> : null}
    {loaded && !rows.length ? <Empty description={filtered ? '没有匹配知识库' : '还没有知识库，从新建知识库开始。'} /> : null}
    <div className={w.list} aria-label="知识库浏览结果">{sorted.map((row) => <Card key={row.wikiId} hoverable tabIndex={0} aria-label={`知识库 ${row.name}`} onClick={() => onOpen(row.wikiId)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(row.wikiId); } }}>
      <div className={w.libraryHeader}>
        <Button type="link" aria-label={`打开知识库 ${row.name}`} onClick={(event) => { event.stopPropagation(); onOpen(row.wikiId); }}>{row.name}</Button>
        <div onClick={(event) => event.stopPropagation()}><Button size="small" onClick={() => setDialog({ library: row })}>属性</Button> <Button size="small" danger autoInsertSpace={false} aria-label={`删除知识库 ${row.name}`} onClick={async () => { if (!onBeforeDelete || await onBeforeDelete(row.wikiId)) { setConfirmName(''); setDeleteError(undefined); setDeleteTarget(row); } }}>删除</Button></div>
      </div>
      <Typography.Text type="secondary">{row.summary || '未填写用途'}</Typography.Text>
      <div className={w.libraryMeta}><span>{row.pageCount ?? 0} 个页面</span><Tag>{statusLabels[row.status] ?? row.status}</Tag>{row.syncError ? <Typography.Text type="danger">{row.syncError}</Typography.Text> : null}</div>
    </Card>)}</div>
    <WikiLibraryDialog open={!!dialog} visible={visible} library={dialog?.library} onClose={() => setDialog(undefined)} onSaved={(saved) => { const created = !dialog?.library; setDialog(undefined); setRefresh((value) => value + 1); if (created) onOpen(saved.wikiId); }} />
    <Modal open={!!deleteTarget} title="确认删除知识库" closable={!deleting} keyboard={!deleting} onCancel={() => { if (!deleting) setDeleteTarget(undefined); }} onOk={() => void confirmDelete()} okText="确认删除" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: !deleteTarget || confirmName !== deleteTarget.name, autoInsertSpace: false }}>
      {deleteError ? <Alert type="error" title={deleteError} showIcon /> : null}
      <p>删除后不可恢复。输入知识库名称确认。</p>
      <Input aria-label="输入知识库名称确认" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
    </Modal>
  </section>;
}
