import { useEffect, useRef, useState } from 'react';
import {
  tencentdbApi,
  type TencentdbKnowledgeAssets,
  useTencentdbConnection,
} from '../../../../features/tencentdb/tencentdbApi';
import { ProjectContextTabs, type ProjectContextTab } from './ProjectContextTabs';
import { wsStyles as s } from './styles';

interface ProjectContextPanelProps {
  active: boolean;
  workspace: string;
}

function workspaceName(workspace: string): string {
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || workspace;
}

export function ProjectContextPanel({ active, workspace }: ProjectContextPanelProps) {
  const { status } = useTencentdbConnection();
  const [activeTab, setActiveTab] = useState<ProjectContextTab>('overview');
  const [knowledge, setKnowledge] = useState<TencentdbKnowledgeAssets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const connected = status?.state === 'ready';

  useEffect(() => {
    const current = ++generation.current;
    setActiveTab('overview');
    setKnowledge(null);
    setError(null);
    if (!active || !connected) return;

    void tencentdbApi.listKnowledgeAssets(workspace)
      .then((assets) => {
        if (generation.current === current) setKnowledge(assets);
      })
      .catch((cause) => {
        if (generation.current === current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      generation.current += 1;
    };
  }, [active, connected, workspace]);

  return (
    <section aria-label={`${workspaceName(workspace)} 项目上下文`} className={s.projectContextPanel}>
      <header className={s.projectContextPanelHeader}>
        <strong>{workspaceName(workspace)}</strong>
        <span className={s.projectContextPanelPath}>{workspace}</span>
      </header>
      {!connected ? <div className={s.projectContextEmpty}>TencentDB 知识未连接。</div> : null}
      {connected && error ? <div role="alert" className={s.projectContextPanelMessage}>{error}</div> : null}
      {connected && !error ? (
        <ProjectContextTabs activeTab={activeTab} knowledge={knowledge} onTabChange={setActiveTab} workspace={workspace} />
      ) : null}
    </section>
  );
}
