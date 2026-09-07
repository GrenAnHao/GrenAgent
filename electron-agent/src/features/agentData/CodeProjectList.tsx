import type { CodeGraphProject, CodeGraphStatus } from '../../lib/agentData';
import { pathsEquivalent } from '../../lib/pathUtils';
import type { ProjectOption } from './useProjectOptions';
import { codeStyles as styles } from './codeStyles';

interface CodeProjectListProps {
  options: ProjectOption[];
  project: string;
  indexState?: CodeGraphProject[];
  status?: CodeGraphStatus;
  onSelect: (workspace: string) => void;
}

export function CodeProjectList({ options, project, indexState, status, onSelect }: CodeProjectListProps) {
  function stateLabel(workspace: string) {
    if (status && pathsEquivalent(status.workspace, workspace)) return status.indexed ? '已索引' : '未索引';
    const reference = indexState?.find((entry) => pathsEquivalent(entry.workspace, workspace));
    if (!reference) return '未检查';
    return reference.indexed ? '索引参考：已索引' : '索引参考：未索引';
  }
  return <div>
    <select className={styles.select} aria-label="项目" value={project} onChange={(event) => onSelect(event.target.value)}>
      <option value="">请选择项目</option>
      {options.map((option) => <option key={option.cwd} value={option.cwd}>{option.name} · {option.cwd}（{stateLabel(option.cwd)}）</option>)}
    </select>
    <div className={styles.hint}>项目路径用于区分同名目录；索引参考不代替当前项目状态检查。</div>
  </div>;
}
