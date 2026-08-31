import { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type WikiOverview, type WikiSearchResult } from '../../lib/agentData';
import { styles } from './agentDataStyles';

interface WikiPanelProps { workspace?: string; onJobCreated?: () => void }

export function WikiPanel({ workspace, onJobCreated }: WikiPanelProps) {
  const [overview, setOverview] = useState<WikiOverview>();
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!workspace) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void agentDataApi.wiki.overview(workspace).then((value) => { if (!cancelled) setOverview(value); }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace]);
  useEffect(() => {
    if (!workspace || !query.trim()) { setResults([]); return; }
    let cancelled = false;
    void agentDataApi.wiki.search(workspace, query.trim(), 50).then((value) => { if (!cancelled) setResults(value); }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [workspace, query]);
  const sync = async () => {
    if (!workspace) return;
    setSyncing(true);
    try { await agentDataApi.jobs.create({ kind: 'wiki.sync', workspace }); onJobCreated?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSyncing(false); }
  };
  return <section data-testid="wiki-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Wiki RAG</h3><span className={styles.hint}>{overview?.pages ?? '-'} 页 · {workspace ?? '未绑定工作区'}</span></div>
    <div className={styles.toolbar}><div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Search size={13} /><input aria-label="搜索 Wiki" placeholder="搜索 Wiki 页面" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} /></div><button type="button" className={styles.actionButton} onClick={() => void sync()} disabled={!workspace || syncing}><RefreshCw size={12} />同步 Wiki</button></div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {loading ? <div className={styles.state}>正在加载 Wiki...</div> : !workspace ? <div className={styles.state}>未绑定工作区</div> : results.length === 0 ? <div className={styles.state}>{query ? '暂无匹配页面' : '输入关键词搜索 Wiki'}</div> : <table className={styles.table}><thead><tr><th>页面</th><th>摘要</th><th>来源</th><th>分块</th></tr></thead><tbody>{results.map((result) => <tr key={result.page}><td>{result.title}</td><td>{result.snippet}</td><td>{result.sourcePath}</td><td>{result.chunks} 个分块</td></tr>)}</tbody></table>}
  </section>;
}
