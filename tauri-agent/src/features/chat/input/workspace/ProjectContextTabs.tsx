import { cx } from 'antd-style';
import { wsStyles as s } from './styles';

export const projectContextTabs = [
  { id: 'overview', label: '概览' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'codegraph', label: 'CodeGraph' },
  { id: 'memory', label: '记忆' },
  { id: 'git', label: 'Git' },
] as const;

export type ProjectContextTab = (typeof projectContextTabs)[number]['id'];

interface ProjectContextTabsProps {
  activeTab: ProjectContextTab;
  onTabChange: (tab: ProjectContextTab) => void;
}

/** 项目上下文的标签壳；各标签的真实数据内容由后续功能填充。 */
export function ProjectContextTabs({ activeTab, onTabChange }: ProjectContextTabsProps) {
  const active = projectContextTabs.find((tab) => tab.id === activeTab) ?? projectContextTabs[0];

  return (
    <>
      <div aria-label="项目上下文标签" className={s.projectContextTabList} role="tablist">
        {projectContextTabs.map((tab) => (
          <button
            aria-controls={`project-context-panel-${tab.id}`}
            aria-selected={tab.id === activeTab}
            className={cx(s.projectContextTab, tab.id === activeTab && s.projectContextTabActive)}
            id={`project-context-tab-${tab.id}`}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <section
        aria-labelledby={`project-context-tab-${active.id}`}
        className={s.projectContextTabPanel}
        id={`project-context-panel-${active.id}`}
        role="tabpanel"
      >
        {active.label} 内容
      </section>
    </>
  );
}
