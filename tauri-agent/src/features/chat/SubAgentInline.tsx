import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Bot, PanelRightOpen } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ConvStrip } from './conv/ConvStrip';
import type { ConvStatus } from './conv/StatusGlyph';
import { LazyMarkdown } from './LazyMarkdown';
import {
  formatTokens,
  isBackgroundSpawn,
  subAgentFinalText,
  subAgentId,
  subAgentRoleLabel,
  subAgentStats,
  subAgentStepCount,
} from '../panels/subagentUtils';
import { useSubAgentLive } from '../../hooks/useSubAgentLive';
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
  statRow: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  statKey: css`
    flex: none;
    padding: 1px 6px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
  `,
  sectionLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
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
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function mapRegistryStatus(status: string | undefined): ConvStatus {
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'cancelled') return 'error';
  return 'done';
}

/** 剥 markdown 的任务摘要：单行化、去标记、截断到 80 字。 */
function taskPlain(task: string): string {
  const oneLine = (task ?? '').replace(/\s+/g, ' ').trim();
  const plain = oneLine.replace(/[#*_`>]/g, '').trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}

/** 终态错误首行（取首个非空行）。 */
function errorFirstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? '';
}

/**
 * 流内内联子代理（L3 横条）：折叠头=ConvStrip 双行（角色前置 + 模型靠右 + 实时/摘要第二行，
 * 运行中左图标 hover 变停止）；展开=E1（统计头 + 打开完整对话 + 结果优先 + 指令默认折叠）。
 * 展开只渲染静态任务与最终结果文本，不内联回放流式 transcript（完整回放在右坞）。
 */
function SubAgentInlineInner({ messageId, toolCallId, index, task, result, status }: SubAgentInlineProps) {
  const { workspace } = useAgentStoreContext();
  const agentId = useMemo(() => subAgentId(result), [result]);
  const background = useMemo(() => isBackgroundSpawn(result), [result]);
  const [bgStatus, setBgStatus] = useState<string | null>(background ? 'running' : null);
  const [expanded, setExpanded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
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

  const running = effectiveStatus === 'running';

  // 运行中按 agentId 轮询 registry 取模型 + 最新一步（非运行/无 id 时静默）。
  const live = useSubAgentLive(workspace, agentId, running);

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
  const badge =
    effectiveStatus === 'done'
      ? `已完成${steps ? ` · ${steps} 步` : ''}`
      : effectiveStatus === 'error'
        ? bgStatus === 'cancelled'
          ? '已停止'
          : `出错${steps ? ` · ${steps} 步` : ''}`
        : '';

  const role = subAgentRoleLabel(task);
  // 模型：运行中取实时；终态取 transcript 统计；无则不显示。
  const modelLabel = running ? live.model ?? undefined : stats?.model;
  // 第二行任务摘要：仅在与角色不同时显示，避免与第一行角色重复。
  const summary = role === task ? '' : taskPlain(task);
  const line2: string = running
    ? live.step != null
      ? `第 ${live.step} 步 · ${live.action ?? '进行中…'}`
      : '运行中…'
    : [badge, effectiveStatus === 'error' && finalText ? errorFirstLine(finalText) : summary]
        .filter(Boolean)
        .join(' · ');

  return (
    <div data-testid="subagent-inline">
      <ConvStrip
        status={effectiveStatus}
        icon={Bot}
        title={`子代理 #${index}`}
        role={role}
        model={modelLabel}
        line2={line2}
        open={expanded}
        onToggle={() => setExpanded((v) => !v)}
        onStop={running ? stop : undefined}
      />

      {expanded ? (
        <div className={styles.body}>
          <div className={styles.statRow}>
            {modelLabel ? <span className={styles.statKey}>{modelLabel}</span> : null}
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
                <LazyMarkdown variant="chat" fontSize={13}>
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
          {showPrompt ? (
            <div className={styles.promptBox}>
              <LazyMarkdown variant="chat" fontSize={13}>
                {task}
              </LazyMarkdown>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const SubAgentInline = memo(SubAgentInlineInner);
