import { useState } from 'react';
import { ProjectContextTabs, type ProjectContextTab } from './ProjectContextTabs';
import { wsStyles as s } from './styles';

interface ProjectContextPanelProps { active: boolean; workspace: string }
function workspaceName(workspace: string): string { const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/); return parts.at(-1) || workspace; }
export function ProjectContextPanel({ active, workspace }: ProjectContextPanelProps) {
  const [activeTab, setActiveTab] = useState<ProjectContextTab>('overview');
  if (!active) return null;
  return <section aria-label={`${workspaceName(workspace)} 项目上下文`} className={s.projectContextPanel}>
    <header className={s.projectContextPanelHeader}><strong>{workspaceName(workspace)}</strong><span className={s.projectContextPanelPath}>{workspace}</span></header>
    <ProjectContextTabs activeTab={activeTab} onTabChange={setActiveTab} workspace={workspace} />
  </section>;
}
