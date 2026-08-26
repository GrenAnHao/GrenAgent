import { useEffect, useRef, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
import { FolderGit2 } from 'lucide-react';
import {
  tencentdbApi,
  type TencentdbKnowledgeAssets,
  useTencentdbConnection,
} from '../../../../features/tencentdb/tencentdbApi';
import { onPiEvent } from '../../../../lib/pi';
import { isUnder } from '../../../../lib/pathUtils';
import type { TencentdbKnowledgeStatus } from '../../../../lib/tencentdb';
import { useSessionStore } from '../../../../store/session';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useGitInfo, useGitStore } from '../../../../stores/gitStore';
import { BranchPicker } from './BranchPicker';
import { ProjectContextCard } from './ProjectContextCard';
import { TaskTray } from './TaskTray';
import { wsStyles as s } from './styles';
import type { PastedText } from '../editor/types';

export interface WorkspaceBarProps {
  /** 项目上下文抽屉将引用内容加入当前输入区，不触发发送。 */
  onReferencePastedText?: (item: PastedText) => void;
}

/** 取路径末段作为工作区显示名。 */
function workspaceName(ws: string): string {
  const parts = ws.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || ws;
}

function knowledgeStatusLabel(status: TencentdbKnowledgeStatus): string {
  if (status === 'ready') return '已就绪';
  if (status === 'processing' || status === 'pending') return '同步中';
  return '不可用';
}

function projectKnowledgeSummary(knowledge: TencentdbKnowledgeAssets): string {
  const workspaceAssets = knowledge.workspace;
  const wikis = workspaceAssets?.wikiId
    ? knowledge.wikis.filter((wiki) => wiki.wiki_id === workspaceAssets.wikiId)
    : [];
  const codeGraphs = workspaceAssets?.codeGraphId
    ? knowledge.codeGraphs.filter((graph) => graph.code_graph_id === workspaceAssets.codeGraphId)
    : [];
  const summary: string[] = [];
  if (wikis.length === 0 && codeGraphs.length === 0) {
    summary.push('暂无项目知识');
  }

  const files = codeGraphs.reduce((total, graph) => total + (graph.stats?.files ?? 0), 0);
  const nodes = codeGraphs.reduce((total, graph) => total + (graph.stats?.nodes ?? 0), 0);
  if (wikis.length > 0 || codeGraphs.length > 0) {
    summary.push(`${wikis.length} 篇 Wiki`);
    if (files > 0) summary.push(`${files} 文件`);
    if (nodes > 0) summary.push(`${nodes} 节点`);
    if (files === 0 && nodes === 0 && codeGraphs.length > 0) summary.push(`${codeGraphs.length} 个代码图谱`);
  }
  if (wikis.length > 0) summary.push(`Wiki：${knowledgeStatusLabel(wikis[0].status)}`);
  if (codeGraphs.length > 0) summary.push(`CodeGraph：${knowledgeStatusLabel(codeGraphs[0].status)}`);

  const errors = [
    workspaceAssets?.error,
    ...wikis.map((wiki) => wiki.sync_error),
    ...codeGraphs.map((graph) => graph.sync_error),
  ].filter((error): error is string => Boolean(error));
  if (errors.length > 0) summary.push(`项目知识不可用：${errors.join('；')}`);
  summary.push('项目记忆不可用');
  return summary.join(' · ');
}

/**
 * 工作区 / Git 功能栏：当前工作区 + 分支(改动数；气泡内含「查看改动」diff 与「Git 图谱」) + 后台任务。
 * 渲染于输入框上方（MessageEditor 的 zone，与 GoalPill 同层）。
 * 首次挂载 / agent_end / tool_execution_end 时刷新 git 概况。
 */
export function WorkspaceBar(_props: WorkspaceBarProps) {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((state) => state.worksDir);
  const { status } = useTencentdbConnection();
  const isConversation = Boolean(worksDir && isUnder(workspace, worksDir));
  const connected = status?.state === 'ready';
  const git = useGitInfo(workspace);
  const [knowledgeSummary, setKnowledgeSummary] = useState<string | null>(null);
  const [knowledgeError, setKnowledgeError] = useState(false);
  const [projectContextOpen, setProjectContextOpen] = useState(false);
  const knowledgeGeneration = useRef(0);
  const knowledgeScope = useRef('');
  const scope = `${workspace}\u0000${connected}`;
  knowledgeScope.current = scope;

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

  useEffect(() => {
    const generation = ++knowledgeGeneration.current;
    setProjectContextOpen(false);
    setKnowledgeSummary(null);
    setKnowledgeError(false);
    if (!workspace || isConversation || !connected) return;

    const isCurrent = () => (
      knowledgeGeneration.current === generation && knowledgeScope.current === scope
    );
    void tencentdbApi.listKnowledgeAssets(workspace)
      .then((knowledge) => {
        if (isCurrent()) setKnowledgeSummary(projectKnowledgeSummary(knowledge));
      })
      .catch(() => {
        if (isCurrent()) setKnowledgeError(true);
      });
    return () => {
      knowledgeGeneration.current += 1;
    };
  }, [connected, isConversation, scope, workspace]);

  if (!workspace || isConversation) return null;

  const isRepo = git.current !== '' || git.branches.length > 0;
  const summary = connected
    ? knowledgeError
      ? '项目知识不可用'
      : knowledgeSummary ?? '正在读取项目知识'
    : '知识未连接';

  return (
    <div className={s.bar}>
      <ProjectContextCard
        name={workspaceName(workspace)}
        open={projectContextOpen}
        summary={summary}
        onOpen={() => setProjectContextOpen(true)}
      />
      <span className={cx(s.chip, s.chipReadonly)} title={workspace}>
        <Icon icon={FolderGit2} size={14} />
        <span className={s.chipName}>{workspaceName(workspace)}</span>
      </span>
      {isRepo ? <BranchPicker /> : null}
      <TaskTray />
    </div>
  );
}
