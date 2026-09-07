import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Tag } from 'antd';
import { RefreshCw } from 'lucide-react';
import { agentDataApi } from '../../../lib/agentData';
import type { WikiLibraryView, WikiTarget } from '../../../../electron/agentData/wikiContracts';
import { useProjectOptions } from '../useProjectOptions';
import { styles } from '../agentDataStyles';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { WikiDeleteDialog } from './WikiDeleteDialog';
import { wikiStyles as w } from './wikiStyles';

interface Props { visible: boolean; onOpen(kbId: string): void; refreshVersion: number; onBeforeDelete?(kbId: string): Promise<boolean>; onDeleted?(kbId: string): void }

export function WikiLibraryList({ visible, onOpen, refreshVersion, onBeforeDelete, onDeleted }: Props) {
  const projects = useProjectOptions();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [project, setProject] = useState('');
  const [order, setOrder] = useState('updated');
  const [rows, setRows] = useState<WikiLibraryView[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<{ library?: WikiLibraryView }>();
  const [deleteTarget, setDeleteTarget] = useState<WikiTarget>();
  const sequence = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const request = ++sequence.current;
    if (!visible) return;
    setLoading(true);
    void agentDataApi.wiki.libraries.list({ query: debounced, ...(project ? { project } : {}) })
      .then((next) => { if (sequence.current === request) { setRows(next); setError(undefined); setLoaded(true); } })
      .catch((cause) => { if (sequence.current === request) setError(String(cause)); })
      .finally(() => { if (sequence.current === request) setLoading(false); });
    return () => { sequence.current++; };
  }, [visible, debounced, project, refreshVersion, refresh]);
  const sorted = useMemo(() => [...rows].sort((a, b) => order === 'name' ? a.name.localeCompare(b.name, 'zh') : b.updatedAt - a.updatedAt), [rows, order]);
  const projectName = (cwd: string) => projects.find((item) => item.cwd === cwd)?.name ?? cwd;
  const filtered = !!debounced || !!project;
  return <section className={w.root} hidden={!visible} aria-label="知识库列表">
    <header className={w.listHeader}><div><h3>知识库</h3><p className={w.muted}>管理原始资料与知识页面，按需关联到多个项目。</p></div><Button type="primary" onClick={() => setDialog({})}>新建知识库</Button></header>
    <div className={w.listToolbar}>
      <Input aria-label="搜索知识库" placeholder="搜索名称或用途" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 180 }} />
      <select className={styles.select} aria-label="关联项目筛选" value={project} onChange={(event) => setProject(event.target.value)}><option value="">全部项目</option>{projects.map((item) => <option key={item.cwd} value={item.cwd}>{item.name}</option>)}</select>
      <select className={styles.select} aria-label="知识库排序" value={order} onChange={(event) => setOrder(event.target.value)}><option value="updated">最近更新</option><option value="name">名称排序</option></select>
      <Button aria-label="刷新知识库" icon={<RefreshCw size={14} />} disabled={loading} onClick={() => setRefresh((value) => value + 1)} />
    </div>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {!loaded && loading ? <p role="status">正在加载知识库…</p> : null}
    {loaded && !rows.length ? <div className={styles.state}>{filtered ? '没有匹配知识库' : '还没有知识库，从新建知识库开始。'}</div> : null}
    <div className={w.list} aria-label="知识库浏览结果">{sorted.map((row) => <article key={row.kbId} className={w.library} tabIndex={0} aria-label={`知识库 ${row.name}`} onClick={() => onOpen(row.kbId)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(row.kbId); } }}>
      <div className={w.libraryHeader}>
        <button type="button" className={w.libraryName} aria-label={`打开知识库 ${row.name}`} onClick={(event) => { event.stopPropagation(); onOpen(row.kbId); }}>{row.name}</button>
        <div onClick={(event) => event.stopPropagation()}><Button size="small" onClick={() => setDialog({ library: row })}>属性</Button> <Button size="small" danger onClick={async () => { if (!onBeforeDelete || await onBeforeDelete(row.kbId)) setDeleteTarget({ kind: 'library', kbId: row.kbId }); }}>删除</Button></div>
      </div>
      <p className={w.muted}>{row.description || '未填写用途'}</p>
      <div className={w.libraryMeta}><span>{row.sourceCount} 份资料 · {row.pageCount} 个页面</span><span>{row.bindings.map(projectName).join('、') || '未关联项目'}</span><Tag>{({ draft: '草稿', pending: '待抽取', available: '可用' })[row.availability]}</Tag><span>{row.pendingSourceCount} 份待抽取</span>{row.activeJobId ? <span>活动任务：{row.activeJobId}</span> : null}{row.lifecycle !== 'active' ? <span>正在删除</span> : null}</div>
      {row.lastError ? <p className={styles.inlineError}>{row.lastError}</p> : null}
    </article>)}</div>
    <WikiLibraryDialog open={!!dialog} visible={visible} library={dialog?.library} onClose={() => setDialog(undefined)} onSaved={(saved) => { const created = !dialog?.library; setDialog(undefined); setRefresh((value) => value + 1); if (created) onOpen(saved.kbId); }} />
    <WikiDeleteDialog target={visible ? deleteTarget : undefined} onClose={() => setDeleteTarget(undefined)} onDeleted={(target) => { setRefresh((value) => value + 1); onDeleted?.(target.kbId); }} onWaiting={() => setRefresh((value) => value + 1)} />
  </section>;
}
