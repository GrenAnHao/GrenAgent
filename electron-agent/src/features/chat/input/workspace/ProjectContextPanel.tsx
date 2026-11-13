import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentDataApi,
  type CodeGraphStatus,
} from '../../../../lib/agentData';
import { wsStyles as s } from './styles';

interface ProjectContextPanelProps { active: boolean; workspace: string }

export function ProjectContextPanel({ active, workspace }: ProjectContextPanelProps) {
  const name = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace;
  const generation = useRef(0);
  const [summary, setSummary] = useState<CodeGraphStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const code = await agentDataApi.code.status(workspace);
      if (generation.current === current) setSummary(code);
    } catch (cause) {
      if (generation.current === current) {
        setSummary(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    setSummary(undefined);
    setError(undefined);
    if (active) void load();
    return () => { generation.current += 1; };
  }, [active, load]);

  return (
    <section aria-label={`${name} 项目上下文`} className={s.projectContextPanel}>
      <header className={s.projectContextPanelHeader}>
        <strong>{name}</strong>
        <span className={s.projectContextPanelPath}>{workspace}</span>
      </header>
      <div className={s.projectContextTabPanel}>
        {loading ? <div className={s.projectContextEmpty}>正在加载项目数据...</div> : null}
        {error ? (
          <div className={s.projectContextStack} role="alert">
            <div className={s.projectContextPanelMessage}>{error}</div>
            <button aria-label="重新加载项目数据" className={s.projectContextTab} onClick={() => void load()} title="重新加载项目数据" type="button">
              <RefreshCw size={14} />
            </button>
          </div>
        ) : null}
        {!loading && summary ? (
          <div className={s.projectContextOverview}>
            <div>
              <strong>{summary.files ?? 0} 个文件</strong>
              <span>{summary.connected && summary.indexed ? `${summary.nodes ?? 0} 个节点 · ${summary.edges ?? 0} 条边` : 'CodeGraph 尚未连接'}</span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
