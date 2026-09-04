import { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type CodeGraphProject, type CodeGraphStatus, type CodeSearchResult } from '../../lib/agentData';
import { styles } from './agentDataStyles';
import { useProjectOptions } from './useProjectOptions';

interface CodeRetrievalPanelProps {
  /** 仅作为选择器的初始值；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
  onJobCreated?: () => void;
}

export function CodeRetrievalPanel({ initialProject, onJobCreated }: CodeRetrievalPanelProps) {
  const options = useProjectOptions();
  // 代码符号图不能跨仓库合并，所以这里是「必选」而不是「筛选」。
  const [project, setProject] = useState<string>(initialProject ?? '');
  const [indexState, setIndexState] = useState<CodeGraphProject[]>([]);
  const [status, setStatus] = useState<CodeGraphStatus>();
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void agentDataApi.code.projects()
      .then((value) => { if (!cancelled) setIndexState(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!project) { setStatus(undefined); return; }
    let cancelled = false;
    setLoading(true);
    void agentDataApi.code.status(project)
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    if (!project || !status?.indexed || !query.trim()) { setResults([]); return; }
    let cancelled = false;
    void agentDataApi.code.search(project, query.trim(), 20)
      .then((value) => { if (!cancelled) { setResults(value.results); if (!value.available && value.message) setError(value.message); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [project, status?.indexed, query]);

  const sync = async () => {
    if (!project) return;
    setSyncing(true);
    try { await agentDataApi.jobs.create({ kind: 'codegraph.sync', workspace: project }); onJobCreated?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSyncing(false); }
  };

  const indexedOf = (cwd: string) => indexState.find((entry) => entry.workspace === cwd)?.indexed ?? false;

  return <section data-testid="code-retrieval-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Code Retrieval</h3><span className={styles.hint}>{project || '未选择项目'}</span></div>
    <div className={styles.toolbar}>
      <select className={styles.select} aria-label="项目" value={project} onChange={(event) => setProject(event.target.value)}>
        <option value="">请选择项目</option>
        {options.map((option) => <option key={option.cwd} value={option.cwd}>{option.name}{indexedOf(option.cwd) ? '' : '（未索引）'}</option>)}
      </select>
      {project ? <button type="button" className={styles.actionButton} onClick={() => void sync()} disabled={syncing}><RefreshCw size={12} />同步索引</button> : null}
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {!project ? <div className={styles.state}>请选择一个项目</div>
      : loading ? <div className={styles.state}>正在检查 CodeGraph...</div>
      : !status?.indexed ? <div className={styles.state}><strong>该项目尚未建立 CodeGraph 索引</strong><div>点「同步索引」为该项目建立索引。</div></div>
      : <>
        <div className={styles.statusGrid}><div className={styles.card}>
          <div className={styles.statusRow}><span className={styles.statusName}>索引状态</span><span className={styles.statusValue}>{status.state ?? 'indexed'}</span></div>
          <div className={styles.statusRow}><span className={styles.statusName}>文件 / 节点 / 边</span><span className={styles.statusValue}>{status.files ?? 0} / {status.nodes ?? 0} / {status.edges ?? 0}</span></div>
        </div></div>
        <div className={styles.toolbar}><div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Search size={13} />
          <input aria-label="搜索代码" placeholder="搜索文件或符号" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} />
        </div></div>
        {results.length === 0 ? <div className={styles.state}>输入关键词检索代码</div>
          : <table className={styles.table}>
            <thead><tr><th>文件</th><th>行号</th><th>符号</th><th>内容</th></tr></thead>
            <tbody>{results.map((result, index) => <tr key={`${result.file}:${result.line ?? index}`}>
              <td>{result.file}</td><td>{result.line ?? '-'}</td><td>{result.symbol ?? '-'}</td><td>{result.snippet ?? ''}</td>
            </tr>)}</tbody>
          </table>}
      </>}
  </section>;
}
