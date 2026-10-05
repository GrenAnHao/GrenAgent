import { useEffect } from 'react';
import { Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
import { BookOpenText, FolderGit2 } from 'lucide-react';
import { onPiEvent } from '../../../../lib/pi';
import { isUnder } from '../../../../lib/pathUtils';
import { useSessionStore } from '../../../../store/session';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useDockStore } from '../../../../stores/dockStore';
import { useGitStore } from '../../../../stores/gitStore';
import { BranchPicker } from './BranchPicker';
import { TaskTray } from './TaskTray';
import { wsStyles as s } from './styles';
import type { PastedText } from '../editor/types';
import { useComposerCompact } from '../composerCompact';

export interface WorkspaceBarProps {
  /** 保留输入区引用回调兼容性，项目上下文入口由右侧 Dock 承载。 */
  onReferencePastedText?: (item: PastedText) => void;
}

/** 取路径末段作为工作区显示名。 */
function workspaceName(ws: string): string {
  const parts = ws.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || ws;
}

/**
 * 工作区 / Git 功能栏：当前工作区 + 分支(改动数；气泡内含「查看改动」diff 与「Git 历史」) + 后台任务。
 * 渲染于输入卡片外侧底部。
 * 首次挂载 / agent_end / tool_execution_end 时刷新 git 概况。
 */
export function WorkspaceBar(_props: WorkspaceBarProps) {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((state) => state.worksDir);
  const isConversation = Boolean(worksDir && isUnder(workspace, worksDir));
  const openProjectContext = useDockStore((state) => state.openProjectContext);
  const compact = useComposerCompact();

  useEffect(() => {
    if (!workspace || isConversation) return;
    void useGitStore.getState().load(workspace, true);
    let unlisten: (() => void) | undefined;
    void onPiEvent((e) => {
      if (e.workspace !== workspace) return;
      if (e.event.type === 'agent_end' || e.event.type === 'tool_execution_end') {
        void useGitStore.getState().load(workspace, true);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [workspace, isConversation]);

  if (!workspace || isConversation) return null;

  return (
    <div className={cx(s.bar, compact && s.barCompact)}>
      <span className={cx(s.chip, s.chipReadonly)} title={workspace}>
        <Icon icon={FolderGit2} size={14} />
        {compact ? null : <span className={s.chipName}>{workspaceName(workspace)}</span>}
      </span>
      <BranchPicker />
      <TaskTray />
      <button
        aria-label="项目上下文"
        className={s.chip}
        title="项目上下文"
        type="button"
        onClick={() => openProjectContext(workspace)}
      >
        <Icon icon={BookOpenText} size={14} />
        {compact ? null : <span>项目上下文</span>}
      </button>
    </div>
  );
}
