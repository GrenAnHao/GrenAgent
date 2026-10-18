import { useEffect } from 'react';
import { Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
import { App } from 'antd';
import { ArrowUpFromLine, BookOpenText, FolderGit2, ShieldCheck } from 'lucide-react';
import { isolatedPathOf } from '../../../../lib/isolatedWorkspace';
import { useIsolatedWorkspaceStore } from '../../../../stores/isolatedWorkspaceStore';
import { syncBackIsolated } from '../../../isolatedWorkspace/actions';
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
  const { message } = App.useApp();
  // 独立工作区（A 轨）：标出来，并给回传入口。形状对还要主进程确认它是托管的、目录还在。
  const iso = isolatedPathOf(workspace);
  const isoKind = useIsolatedWorkspaceStore((state) => (workspace ? state.kinds[workspace] : undefined));
  useEffect(() => {
    if (iso && workspace) void useIsolatedWorkspaceStore.getState().refreshKinds([workspace]);
    // iso 由 workspace 决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);
  const isolated = iso && isoKind === 'active' ? iso : null;

  useEffect(() => {
    if (!workspace || isConversation) return;
    void useGitStore.getState().load(workspace, true);
    let unlisten: (() => void) | undefined;
    void onPiEvent((e) => {
      if (e.workspace !== workspace) return;
      // 子代理的事件不刷新：十个并行时每个工具结束都来一条，每条都跑一遍 git status / branch。
      // 子代理改动的文件在父会话这一轮结束（agent_end）时一并刷新到。
      if (e.source === 'subagent') return;
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
        {compact ? null : (
          <span className={s.chipName}>{isolated ? workspaceName(isolated.parentRoot) : workspaceName(workspace)}</span>
        )}
      </span>
      {isolated ? (
        <span
          className={cx(s.chip, s.chipReadonly)}
          data-testid="workspace-isolated-chip"
          title={`独立工作区 ${isolated.branch}：这里的会话不能写主仓 ${isolated.parentRoot}。改完点「回传」把分支带回主仓。`}
        >
          <Icon icon={ShieldCheck} size={14} />
          {compact ? null : <span>独立工作区</span>}
        </span>
      ) : null}
      {isolated ? (
        <button
          aria-label="回传分支到主仓"
          className={s.chip}
          data-testid="workspace-isolated-sync"
          title={`把 ${isolated.branch} 快进到主仓的同名分支`}
          type="button"
          onClick={() => void syncBackIsolated(isolated.parentRoot, isolated.id, message)}
        >
          <Icon icon={ArrowUpFromLine} size={14} />
          {compact ? null : <span>回传</span>}
        </button>
      ) : null}
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
