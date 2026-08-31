import { useEffect, useState } from 'react';
import { cx } from 'antd-style';
import { pi, type GitLogEntry } from '../../../../lib/pi';
import { wsStyles as s } from './styles';

export const projectContextTabs = [{ id: 'overview', label: '概览' }, { id: 'wiki', label: 'Wiki' }, { id: 'codegraph', label: 'CodeGraph' }, { id: 'memory', label: '记忆' }, { id: 'git', label: 'Git' }] as const;
export type ProjectContextTab = (typeof projectContextTabs)[number]['id'];
interface Props { activeTab: ProjectContextTab; onTabChange: (tab: ProjectContextTab) => void; workspace?: string }
export function ProjectContextTabs({ activeTab, onTabChange, workspace }: Props) {
  const [log, setLog] = useState<GitLogEntry[]>([]);
  useEffect(() => { if (activeTab !== 'git' || !workspace) return; void pi.getGitLogGraph(workspace, 20).then(setLog).catch(() => setLog([])); }, [activeTab, workspace]);
  return <>
    <div aria-label="项目上下文标签" className={s.projectContextTabList} role="tablist">{projectContextTabs.map((tab) => <button key={tab.id} role="tab" aria-selected={tab.id === activeTab} className={cx(s.projectContextTab, tab.id === activeTab && s.projectContextTabActive)} onClick={() => onTabChange(tab.id)}>{tab.label}</button>)}</div>
    <section className={s.projectContextTabPanel} role="tabpanel">
      {activeTab === 'overview' ? <div className={s.projectContextEmpty}>Agent 数据由本地 Runtime 管理。</div> : null}
      {activeTab === 'wiki' ? <div className={s.projectContextEmpty}>Wiki RAG 尚未同步。</div> : null}
      {activeTab === 'codegraph' ? <div className={s.projectContextEmpty}>CodeGraph 索引状态由 Agent 数据中心管理。</div> : null}
      {activeTab === 'memory' ? <div className={s.projectContextEmpty}>Memory L0-L3 由当前模型自动提炼。</div> : null}
      {activeTab === 'git' ? <div className={s.projectContextStack}>{log.map((commit) => <div className={s.projectContextResult} key={commit.hash}><strong>{commit.subject}</strong></div>)}{!log.length ? <div className={s.projectContextEmpty}>暂无 Git 提交记录。</div> : null}</div> : null}
    </section>
  </>;
}
