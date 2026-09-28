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
  return <Select aria-label="项目" virtual={false} value={project} style={{ width: '100%', maxWidth: 360 }} onChange={(value) => onSelect(value)}
    optionLabelProp="title"
    options={[{ value: '', title: '请选择项目', label: '请选择项目' }, ...options.map((option) => ({ value: option.cwd, title: `${option.name} · ${option.cwd}（${stateLabel(option.cwd)}）`, label: <span>{option.name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{option.cwd} · {stateLabel(option.cwd)}</Typography.Text></span> }))]} />;
}
