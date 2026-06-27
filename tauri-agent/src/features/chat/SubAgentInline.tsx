import { ActionIcon, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Bot, CircleStop, PanelRightOpen } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ConvStrip } from './conv/ConvStrip';
import type { ConvStatus } from './conv/StatusGlyph';
import { LazyMarkdown } from './LazyMarkdown';
import {
  formatTokens,
  isBackgroundSpawn,
  subAgentFinalText,
  subAgentId,
  subAgentStats,
  subAgentStepCount,
} from '../panels/subagentUtils';
import { useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-block-start: 6px;
    margin-inline-start: 11px;
    padding-inline-start: 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  sectionLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  sectionLabelRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 4px;
  `,
  promptBox: css`
    overflow: auto;
    max-height: 240px;
    padding: 8px 12px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillTertiary};
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
}));

interface SubAgentInlineProps {
  messageId: string;
  toolCallId: string;
  index: number;
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function mapRegistryStatus(status: string | undefined): ConvStatus {
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'cancelled') return 'error';
  return 'done';
}

/**
 * 流内内联子代理（L3 横条）：折叠头=ConvStrip（bot + 「子代理 #N」+ 任务 chip + 统计/状态 meta）；
 * 展开=指令框 + 结果框 + 打开右坞按钮。展开只渲染静态任务与最终结果文本，不内联回放流式 transcript。
 */
function SubAgentInlineInner({ messageId, toolCallId, index, task, result, status }: SubAgentInlineProps) {
  const { workspace } = useAgentStoreContext();
  const agentId = useMemo(() => subAgentId(result), [result]);
  const background = useMemo(() => isBackgroundSpawn(result), [result]);
  const [bgStatus, setBgStatus] = useState<string | null>(background ? 'running' : null);
  const [expanded, setExpanded] = useState(false);
  const effectiveStatus = useMemo<ConvStatus>(() => {
    if (status === 'running') return 'running';
    if (background && bgStatus === 'running') return 'running';
    if (background && bgStatus) return mapRegistryStatus(bgStatus);
    return status;
  }, [status, background, bgStatus]);

  useEffect(() => {
    if (!background || !agentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const rows = await pi.subagentList(workspace);
        if (cancelled) return;
        const next = rows.find((r) => r.id === agentId)?.status ?? 'done';
        setBgStatus(next);
        if (next !== 'running' && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // 跨进程读 registry 偶发 SQLITE_BUSY：保留上次状态，下个 tick 再试。
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [workspace, background, agentId]);

  const openInDock = (e?: MouseEvent) => {
    e?.stopPropagation();
    useDockStore.getState().openSubAgent({
      messageId,
      toolCallId,
      subIndex: null,
      title: `#${index} ${task}`,
    });
  };

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    if (status === 'running') {
      void pi.abort(workspace);
      return;
    }
    if (agentId && (background || bgStatus === 'running')) {
      void pi.subagentCancel(workspace, agentId);
      setBgStatus('cancelled');
    }
  };

  const running = effectiveStatus === 'running';

  // 统计/步数/最终文本仅在终态解析一次（性能）。
  const stats = useMemo(() => (running ? null : subAgentStats(result)), [running, result]);
  const steps = useMemo(() => (running ? 0 : subAgentStepCount(result)), [running, result]);
  const finalText = useMemo(() => (running ? '' : subAgentFinalText(result)), [running, result]);
  const statsText = stats
    ? [
        stats.model,
        stats.totalToolCalls ? `${stats.totalToolCalls} 个工具` : null,
        stats.totalTokens ? `${formatTokens(stats.totalTokens)} tokens` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const badge =
    effectiveStatus === 'done'
      ? `已完成${steps ? ` · ${steps} 步` : ''}`
      : effectiveStatus === 'error'
        ? bgStatus === 'cancelled'
          ? '已停止'
          : `出错${steps ? ` · ${steps} 步` : ''}`
        : '';
  const meta = running ? '运行中…' : [statsText, badge].filter(Boolean).join(' · ') || undefined;

  return (
    <div data-testid="subagent-inline">
      <ConvStrip
        status={effectiveStatus}
        icon={Bot}
        title={`子代理 #${index}`}
        chip={task}
        meta={meta}
        open={expanded}
        onToggle={() => setExpanded((v) => !v)}
        actions={
          <>
            {running ? <ActionIcon icon={CircleStop} size="small" title="停止子代理" onClick={stop} /> : null}
            <ActionIcon
              icon={PanelRightOpen}
              size="small"
              title="在右侧面板打开完整对话"
              onClick={openInDock}
            />
          </>
        }
      />

      {expanded ? (
        <div className={styles.body}>
          <div>
            <div className={styles.sectionLabel} style={{ marginBlockEnd: 4 }}>
              指令
            </div>
            <div className={styles.promptBox}>
              <LazyMarkdown variant="chat" fontSize={13}>
                {task}
              </LazyMarkdown>
            </div>
          </div>
          <div>
            <div className={styles.sectionLabelRow}>
              <span className={styles.sectionLabel}>结果</span>
              <button type="button" className={styles.openLink} onClick={openInDock}>
                <Icon icon={PanelRightOpen} size={12} />
                打开完整对话
              </button>
            </div>
            {running ? (
              <div className={styles.hint}>运行中…（点「打开完整对话」在右侧面板看实时进度）</div>
            ) : finalText ? (
              <div className={styles.resultBox}>
                <LazyMarkdown variant="chat" fontSize={13}>
                  {finalText}
                </LazyMarkdown>
              </div>
            ) : (
              <div className={styles.hint}>（无输出）</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const SubAgentInline = memo(SubAgentInlineInner);
