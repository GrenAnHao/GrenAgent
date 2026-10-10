import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Bot, PanelRightOpen } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ConvStrip } from './conv/ConvStrip';
import { ModelNameTag } from './ModelNameTag';
import type { ConvStatus } from './conv/StatusGlyph';
import { LazyMarkdown } from './LazyMarkdown';
import { TaskPromptFrame } from './TaskPromptFrame';
import {
  formatTokens,
  isModelAlias,
  backgroundRegistryStatus,
  isBackgroundSpawn,
  subAgentFinalText,
  subAgentId,
  subAgentRecordStatus,
  subAgentResultIndicatesTimeout,
  subAgentTimeoutText,
  modelFromResult,
  modelWithThinking,
  thinkingLevelFromResult,
  subAgentCardTitle,
  subAgentStats,
  subAgentStepCount,
  taskFromAgentResult,
} from '../panels/subagentUtils';
import { useSubAgentLive } from '../../hooks/useSubAgentLive';
import { PendingResponseStatus } from './PendingResponseStatus';
import { dockOwnerFromStore, useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';
import type { SubAgentItem } from '../../lib/pi';
import { selectSubAgentById, useSubAgentLiveStore } from '../../stores/subagentLiveStore';
import { useProviderNames } from '../settings/providerListCache';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-block-start: 6px;
    margin-inline-start: 11px;
    padding-inline-start: 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  statRow: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  sectionLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  resultBox: css`
    overflow: auto;
    max-height: 320px;
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextQuaternary};
  `,
  openLink: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    margin-inline-start: auto;
    padding: 2px 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  toggleLink: css`
    align-self: flex-start;
    padding: 2px 0;
    border: none;
    background: transparent;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
}));

interface SubAgentInlineProps {
  messageId: string;
  toolCallId: string;
  index: number;
  task: string;
  /** 主代理提交的短任务名。缺省时从 task 截一句。 */
  title?: string;
  model?: string;
  thinkingLevel?: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function mapRegistryStatus(status: string | undefined): ConvStatus {
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'cancelled' || status === 'interrupted') return 'error';
  return 'done';
}

/**
 * 流内内联子代理（L3 横条）：折叠头=ConvStrip 双行（角色前置 + 模型靠右 + 实时/摘要第二行，
 * 运行中左图标 hover 变停止；点横条本体在右坞打开完整对话，折叠箭头才展开/收起）；展开=E1（统计头 + 打开完整对话 + 结果优先 + 指令默认折叠）。
 * 展开只渲染静态任务与最终结果文本，不内联回放流式 transcript（完整回放在右坞）。
 */
function SubAgentInlineInner({ messageId, toolCallId, index, task, title, model, thinkingLevel, result, status }: SubAgentInlineProps) {
  const { workspace, store } = useAgentStoreContext();
  const agentId = useMemo(() => subAgentId(result), [result]);
  const background = useMemo(() => isBackgroundSpawn(result), [result]);
  const [bgStatus, setBgStatus] = useState<string | null>(background ? 'running' : null);
  const [bgError, setBgError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const registryRow = useSubAgentLiveStore(selectSubAgentById(workspace, agentId));
  const registryLoaded = useSubAgentLiveStore((s) => s.itemsByWorkspace.has(workspace));
  const [remembered, setRemembered] = useState<SubAgentItem | undefined>();
  const [registryRead, setRegistryRead] = useState(false);
  const providerNames = useProviderNames();
  // 参数里的 cheap / strong 只是别名：结果没写实际路由时（中途出错、运行中）去注册表取，别把别名当模型名。
  const savedModel = modelFromResult(result) || (isModelAlias(model) ? undefined : model);
  const missingTask = !task.trim() || task === '子代理任务';
  const needsMetadata = Boolean(agentId && !registryRead && (!savedModel || missingTask));
  const shownTask = missingTask ? taskFromAgentResult(result) || remembered?.task || task : task;
  const effectiveStatus = useMemo<ConvStatus>(() => {
    if (status === 'running') return 'running';
    if (background && bgStatus === 'running') return 'running';
    if (background && bgStatus) return mapRegistryStatus(bgStatus);
    const child = subAgentRecordStatus(result);
    if (child === 'error' || child === 'cancelled') return 'error';
    return status;
  }, [status, background, bgStatus, result]);

  useEffect(() => {
    if (!registryLoaded || !agentId) return;
    if (registryRow) setRemembered(registryRow);
    setRegistryRead(true);
    if (background) {
      setBgStatus(backgroundRegistryStatus(registryRow));
      setBgError(typeof registryRow?.error === 'string' ? registryRow.error : null);
    }
  }, [registryLoaded, registryRow, background, agentId]);

  const running = effectiveStatus === 'running';

  // 运行中轮询 registry 取模型与状态（通过单例 store，多卡片共享一次轮询）。
  // 旧历史缺字段时只共享首包查询；回包后保留这行、释放订阅，不为每张完成卡单独轮询。
  const live = useSubAgentLive(workspace, agentId, running || needsMetadata);
  const seenModel = useRef<string | undefined>(undefined);
  if (live.model) seenModel.current = live.model;
  const seenLevel = useRef<string | undefined>(undefined);
  if (live.thinkingLevel) seenLevel.current = live.thinkingLevel;

  const openInDock = (e?: MouseEvent) => {
    e?.stopPropagation();
    useDockStore.getState().openSubAgent({
      messageId,
      toolCallId,
      subIndex: null,
      title: `#${index} ${subAgentCardTitle(title, shownTask)}`,
      // tab 归属当前渲染这条消息的会话，切会话后不跟过去。
      ...dockOwnerFromStore(store, workspace),
    });
  };

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    if (status === 'running') {
      void pi.abort(workspace, store.getLoadedSessionPath());
      return;
    }
    if (agentId && (background || bgStatus === 'running')) {
      void pi.subagentCancel(workspace, agentId);
      setBgStatus('cancelled');
    }
  };

  // 统计/步数/最终文本仅在终态解析一次（性能）。
  const stats = useMemo(() => (running ? null : subAgentStats(result)), [running, result]);
  const steps = useMemo(() => (running ? 0 : subAgentStepCount(result)), [running, result]);
  const finalText = useMemo(() => (running ? '' : subAgentFinalText(result)), [running, result]);
  const statsText = stats
    ? [
        stats.totalToolCalls ? `${stats.totalToolCalls} 个工具` : null,
        stats.totalTokens ? `${formatTokens(stats.totalTokens)} tokens` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const timedOut = subAgentResultIndicatesTimeout(result) || subAgentTimeoutText(bgError);
  const childStatus = subAgentRecordStatus(result);
  const badge =
    effectiveStatus === 'done'
      ? `已完成${steps ? ` · ${steps} 步` : ''}`
      : effectiveStatus === 'error'
        ? timedOut
          ? '超时'
          : bgStatus === 'cancelled' || childStatus === 'cancelled'
            ? '已停止'
            : bgStatus === 'interrupted'
              ? '已中断'
              : `出错${steps ? ` · ${steps} 步` : ''}`
        : '';

  const role = subAgentCardTitle(title, shownTask);
  // 终态优先用写进工具结果的模型。内嵌子代理没有 transcript，不能等统计去扫。
  // 标签：模型 · 思考档位。档位同样终态优先用工具结果里写的，运行中读注册表。
  const modelLabel =
    modelWithThinking(
      savedModel || remembered?.model || (running ? live.model : undefined) || seenModel.current || stats?.model || model,
      // 参数里的档位是请求值，子会话会按模型能力收窄；注册表记的是实际值，排在它前面。
      thinkingLevelFromResult(result) || remembered?.thinkingLevel || (running ? live.thinkingLevel : undefined) || seenLevel.current || thinkingLevel,
      providerNames,
    ) ?? '';
  const line2 = running ? (
    <PendingResponseStatus label="正在处理…" startedAt={live.createdAt ?? undefined} />
  ) : (
    badge || (effectiveStatus === 'error' ? '出错' : '')
  );

  return (
    <div className={styles.root} data-testid="subagent-inline">
      <ConvStrip
        status={effectiveStatus}
        icon={Bot}
        title={`子代理 #${index}`}
        role={role}
        model={modelLabel || undefined}
        line2={line2}
        open={expanded}
        onToggle={() => setExpanded((v) => !v)}
        onOpen={openInDock}
        onStop={running ? stop : undefined}
      />

      {expanded ? (
        <div className={styles.body}>
          <div className={styles.statRow}>
            {modelLabel ? <ModelNameTag name={modelLabel} testId="subagent-inline-model" /> : null}
            <span>{running ? '运行中' : badge || '已结束'}</span>
            {statsText ? <span>· {statsText}</span> : null}
            <button type="button" className={styles.openLink} onClick={openInDock}>
              <Icon icon={PanelRightOpen} size={12} />
              打开完整对话
            </button>
          </div>
          <div>
            <div className={styles.sectionLabel} style={{ marginBlockEnd: 4 }}>
              结果
            </div>
            {running ? (
              <div className={styles.hint}>运行中…（点「打开完整对话」在右侧面板看实时进度）</div>
            ) : finalText ? (
              <div className={styles.resultBox}>
                <LazyMarkdown variant="chat" tone="secondary">
                  {finalText}
                </LazyMarkdown>
              </div>
            ) : (
              <div className={styles.hint}>（无输出）</div>
            )}
          </div>
          <button type="button" className={styles.toggleLink} onClick={() => setShowPrompt((v) => !v)}>
            {showPrompt ? '收起指令' : '查看指令'}
          </button>
          {showPrompt ? <TaskPromptFrame text={shownTask} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export const SubAgentInline = memo(SubAgentInlineInner);
