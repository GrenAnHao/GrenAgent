import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type WikiOverview, type WikiSearchResult } from '../../lib/agentData';
import { styles } from './agentDataStyles';
import { useProjectOptions } from './useProjectOptions';

interface WikiPanelProps {
  /** 仅作为筛选器的初始值；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
  onJobCreated?: () => void;
}

export function WikiPanel({ initialProject, onJobCreated }: WikiPanelProps) {
  const projects = useProjectOptions();
  const [project, setProject] = useState<string>(initialProject ?? '');
  const [overview, setOverview] = useState<WikiOverview>();
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();

  // 空字符串 = 全局：不传 workspace，让底层跨全部项目查询。
  const scope = useMemo(() => (project ? project : undefined), [project]);
  const nameOf = (workspace: string) => projects.find((option) => option.cwd === workspace)?.name ?? workspace;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void agentDataApi.wiki.overview(scope)
      .then((value) => { if (!cancelled) setOverview(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let cancelled = false;
    void agentDataApi.wiki.search(scope, query.trim(), 50)
      .then((value) => { if (!cancelled) setResults(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [scope, query]);

  // 同步是"对一个项目扫描生成"，全局视图下没有明确目标，因此必须先选定项目。
  const sync = async () => {
    if (!project) return;
    setSyncing(true);
    try { await agentDataApi.jobs.create({ kind: 'wiki.sync', workspace: project }); onJobCreated?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSyncing(false); }
  };

  return <section data-testid="wiki-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Wiki RAG</h3><span className={styles.hint}>{overview?.pages ?? '-'} 页 · {project ? nameOf(project) : '全部项目'}</span></div>
    <div className={styles.toolbar}>
      <div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Search size={13} />
        <input aria-label="搜索 Wiki" placeholder="搜索 Wiki 页面" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      <select className={styles.select} aria-label="项目范围" value={project} onChange={(event) => setProject(event.target.value)}>
        <option value="">全部项目</option>
        {projects.map((option) => <option key={option.cwd} value={option.cwd}>{option.name}</option>)}
      </select>
      <button type="button" className={styles.actionButton} onClick={() => void sync()} disabled={!project || syncing} title={project ? '扫描该项目的 Markdown 并生成页面' : '请先选择一个项目'}>
        <RefreshCw size={12} />同步 Wiki
      </button>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {loading ? <div className={styles.state}>正在加载 Wiki...</div>
      : results.length === 0 ? <div className={styles.state}>{query ? '暂无匹配页面' : '输入关键词搜索 Wiki'}</div>
      : <table className={styles.table}>
        <thead><tr><th>页面</th><th>摘要</th><th>项目</th><th>来源</th><th>分块</th></tr></thead>
        <tbody>{results.map((result) => <tr key={`${result.workspace}:${result.page}`}>
          <td>{result.title}</td>
          <td>{result.snippet}</td>
          <td>{nameOf(result.workspace)}</td>
          <td>{result.sourcePath}</td>
          <td>{result.chunks} 个分块</td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
