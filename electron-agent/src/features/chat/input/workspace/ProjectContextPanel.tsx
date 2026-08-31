import { wsStyles as s } from './styles';

interface ProjectContextPanelProps { active: boolean; workspace: string }

export function ProjectContextPanel({ workspace }: ProjectContextPanelProps) {
  const name = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace;
  return (
    <section aria-label={`${name} 项目上下文`} className={s.projectContextPanel}>
      <header className={s.projectContextPanelHeader}>
        <strong>{name}</strong>
        <span className={s.projectContextPanelPath}>{workspace}</span>
      </header>
      <div className={s.projectContextEmpty}>项目数据模块正在初始化。</div>
    </section>
  );
}
