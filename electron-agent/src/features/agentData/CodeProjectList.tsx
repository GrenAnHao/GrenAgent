import { Select, Typography } from 'antd';
import type { CodeGraphProject, CodeGraphStatus } from '../../lib/agentData';
import { pathsEquivalent } from '../../lib/pathUtils';
import type { ProjectOption } from './useProjectOptions';

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
    <Select aria-label="项目" virtual={false} value={project} style={{ width: '100%', maxWidth: 560 }} onChange={(value) => onSelect(value)} options={[{ value: '', label: '请选择项目' }, ...options.map((option) => ({ value: option.cwd, label: `${option.name} · ${option.cwd}（${stateLabel(option.cwd)}）` }))]} />
    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>项目路径用于区分同名目录；索引参考不代替当前项目状态检查。</Typography.Paragraph>
  </div>;
}
