import { Select, Typography } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderOpen } from 'lucide-react';
import type { CodeGraphProject, CodeGraphStatus } from '../../lib/agentData';
import { pathsEquivalent } from '../../lib/pathUtils';
import type { ProjectOption } from './useProjectOptions';

const styles = createStaticStyles(({ css }) => ({
  /** 收起态：项目名 + 弱化的路径，单行截断，不再把「（已索引）」挤进标题。 */
  display: css`
    display: flex; align-items: center; gap: 8px; min-width: 0;
    > svg { flex: none; color: ${cssVar.colorTextTertiary}; }
  `,
  name: css`flex: none; font-weight: 500;`,
  path: css`
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: ${cssVar.colorTextTertiary}; font-size: 11px;
  `,
  option: css`display: flex; flex-direction: column; gap: 2px; padding-block: 2px;`,
  optionHead: css`
    display: flex; align-items: center; gap: 6px; font-weight: 500;
    > svg { flex: none; color: ${cssVar.colorTextTertiary}; }
  `,
  optionState: css`margin-inline-start: auto; font-weight: 400; font-size: 11px; color: ${cssVar.colorTextTertiary};`,
}));

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
    optionLabelProp="display"
    options={[{ value: '', title: '请选择项目', display: '请选择项目', label: '请选择项目' }, ...options.map((option) => ({
      value: option.cwd,
      title: `${option.name} · ${option.cwd}（${stateLabel(option.cwd)}）`,
      display: <span className={styles.display}><FolderOpen size={14} /><span className={styles.name}>{option.name}</span><span className={styles.path}>{` · ${option.cwd}`}</span></span>,
      label: <span className={styles.option}>
        <span className={styles.optionHead}><FolderOpen size={14} />{option.name}<span className={styles.optionState}>{stateLabel(option.cwd)}</span></span>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{option.cwd}</Typography.Text>
      </span>,
    }))]} />;
}