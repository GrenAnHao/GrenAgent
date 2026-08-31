import { useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type CodeGraphStatus, type CodeSearchResult } from '../../lib/agentData';
import { styles } from './agentDataStyles';

interface CodeRetrievalPanelProps { workspace?: string; onJobCreated?: () => void }

export function CodeRetrievalPanel({ workspace, onJobCreated }: CodeRetrievalPanelProps) {
  const [status, setStatus] = useState<CodeGraphStatus>();
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!workspace) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void agentDataApi.code.status(workspace).then((value) => { if (!cancelled) setStatus(value); }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace]);
  useEffect(() => {
    if (!workspace || !status?.indexed || !query.trim()) { setResults([]); return; }
    let cancelled = false;
    void agentDataApi.code.search(workspace, query.trim(), 20).then((value) => { if (!cancelled) setResults(value.results); }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [workspace, status?.indexed, query]);
  const sync = async () => {
    if (!workspace) return;
    setSyncing(true);
    try { await agentDataApi.jobs.create({ kind: 'codegraph.sync', workspace }); onJobCreated?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSyncing(false); }
  };
  const unavailable = !status?.connected || !status.indexed;
  return <section data-testid="code-retrieval-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Code Retrieval</h3><span className={styles.hint}>{workspace ?? '未绑定工作区'}</span></div>
    <div className={styles.statusGrid}><div className={styles.card}><div className={styles.statusRow}><span className={styles.statusName}>索引状态</span><span className={styles.statusValue}>{status?.state ?? (status?.indexed ? 'indexed' : 'unavailable')}</span></div><div className={styles.statusRow}><span className={styles.statusName}>文件 / 节点 / 边</span><span className={styles.statusValue}>{status ? `${status.files ?? 0} / ${status.nodes ?? 0} / ${status.edges ?? 0}` : '-'}</span></div></div></div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {loading ? <div className={styles.state}>正在检查 CodeGraph...</div> : !workspace ? <div className={styles.state}>未绑定工作区</div> : unavailable ? <div className={styles.state}><strong>CodeGraph 索引尚未连接</strong><div>请先在此工作区初始化 CodeGraph，再执行同步。</div><button type="button" className={styles.actionButton} onClick={() => void sync()} disabled={syncing}><RefreshCw size={12} />同步索引</button></div> : <><div className={styles.toolbar}><div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Search size={13} /><input aria-label="搜索代码" placeholder="搜索文件或符号" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} /></div><GitBranch size={15} /></div>{results.length === 0 ? <div className={styles.state}>输入关键词检索代码</div> : <table className={styles.table}><thead><tr><th>文件</th><th>行号</th><th>符号</th><th>内容</th></tr></thead><tbody>{results.map((result, index) => <tr key={`${result.file}:${result.line ?? index}`}><td>{result.file}</td><td>{result.line ?? '-'}</td><td>{result.symbol ?? '-'}</td><td>{result.snippet ?? ''}</td></tr>)}</tbody></table>}</>}
  </section>;
}
