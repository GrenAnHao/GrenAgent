import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { agentDataApi, type MemoryOverview, type MemoryRecord, type MemoryScope } from '../../lib/agentData';
import { styles } from './agentDataStyles';
import { useProjectOptions } from './useProjectOptions';

interface MemoryPanelProps {
  userId?: string;
  /** 仅作为筛选器的初始值；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
}

export function MemoryPanel({ userId, initialProject }: MemoryPanelProps) {
  const projects = useProjectOptions();
  const [project, setProject] = useState<string>(initialProject ?? '');
  const [overview, setOverview] = useState<MemoryOverview>();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'all' | '0' | '1' | '2' | '3'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // project 为空 = 全局：用 includeOtherProjects 让底层放开项目边界。
  const scope: MemoryScope | undefined = useMemo(
    () => (userId ? (project ? { userId, projectId: project } : { userId, includeOtherProjects: true }) : undefined),
    [userId, project],
  );

  useEffect(() => {
    if (!scope) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void agentDataApi.memory.overview(scope)
      .then((value) => { if (!cancelled) setOverview(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    if (!scope || !query.trim()) { setRecords([]); return; }
    let cancelled = false;
    void agentDataApi.memory.search(scope, query.trim(), 50)
      .then((value) => { if (!cancelled) setRecords(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [scope, query]);

  const visible = useMemo(() => records.filter((record) => level === 'all' || record.level === Number(level)), [records, level]);

  const remove = async (record: MemoryRecord) => {
    if (!userId || !window.confirm('确认删除这条记忆？')) return;
    // 删除走写入路径，必须带 workspace：全局条目用 '.' 占位，项目条目用其来源项目。
    const workspace = record.sourceProjectId ?? project ?? '.';
    try {
      await agentDataApi.memory.delete({ userId, workspace: workspace || '.' }, record.id);
      setRecords((current) => current.filter((item) => item.id !== record.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const scopeLabel = project ? projects.find((option) => option.cwd === project)?.name ?? project : '全部项目';

  return <section data-testid="memory-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Memory L0-L3</h3><span className={styles.hint}>{overview?.total ?? '-'} 条 · {scopeLabel}</span></div>
    <div className={styles.toolbar}>
      <div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Search size={13} />
        <input aria-label="搜索记忆" placeholder="搜索记忆内容" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      <select className={styles.select} aria-label="项目范围" value={project} onChange={(event) => setProject(event.target.value)}>
        <option value="">全部项目</option>
        {projects.map((option) => <option key={option.cwd} value={option.cwd}>{option.name}</option>)}
      </select>
      <select className={styles.select} aria-label="记忆层级" value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
        <option value="all">全部层级</option>
        <option value="0">L0 对话</option>
        <option value="1">L1 原子</option>
        <option value="2">L2 场景</option>
        <option value="3">L3 画像</option>
      </select>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {loading ? <div className={styles.state}>正在加载 Memory...</div>
      : !userId ? <div className={styles.state}>未绑定用户</div>
      : visible.length === 0 ? <div className={styles.state}>{query ? '暂无匹配记忆' : '输入关键词搜索记忆'}</div>
      : <table className={styles.table}>
        <thead><tr><th>层级</th><th>内容</th><th>来源</th><th>归属</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>{visible.map((record) => <tr key={record.id}>
          <td>L{record.level}</td>
          <td>{record.content}</td>
          <td>{record.source ?? '未记录'}</td>
          <td>{record.scope === 'global' ? '全局' : record.sourceProjectId ?? '未记录'}</td>
          <td>{new Date(record.updatedAt).toLocaleString()}</td>
          <td><button type="button" className={styles.actionButton} aria-label="删除" onClick={() => void remove(record)}><Trash2 size={12} />删除</button></td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
