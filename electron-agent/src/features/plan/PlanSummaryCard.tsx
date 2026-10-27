import { memo } from 'react';
import { Button } from '@lobehub/ui';
import { AlertTriangle, ListChecks, PanelRight } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { PLAN_STATUS_LABELS, planIdFromRef, planKeyOf, usePlanStore, type PlanOwner } from '../../stores/planStore';
import { ConvCard } from '../chat/conv/ConvCard';
import { openPlanDockTab } from './openPlanDockTab';

const styles = createStaticStyles(({ css }) => ({
  title: css`
    padding: 9px 12px 10px;
    font-size: var(--pi-font-size, 14px);
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  meta: css`
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  missing: css`
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding-inline-start: 4px;
    font-size: var(--pi-font-size-secondary, 13px);
    line-height: 1.6;
    color: ${cssVar.colorWarningText};
  `,
}));

/** 卡片所在会话：渲染消息的 agent store 实际加载的那份。 */
function useCardOwner(): PlanOwner {
  const { workspace, store } = useAgentStoreContext();
  return { sessionPath: store.getLoadedSessionPath?.() ?? null, workspace };
}

/**
 * 对话流里的计划摘要卡：只显示状态，点开侧栏。编辑、确认都只在侧栏里做。
 * content 是扩展写的 `[plan:<id>] …`；旧版卡片（JSON）不再渲染。
 */
export const PlanSummaryCard = memo(function PlanSummaryCard({ content }: { content: string }) {
  const planId = planIdFromRef(content);
  const owner = useCardOwner();
  const plan = usePlanStore((s) => s.entries[planKeyOf(owner)]?.plan ?? null);
  if (!planId) return null;

  const current = plan && plan.id === planId ? plan : null;
  const title = current?.title ?? /「(.+)」/.exec(content)?.[1] ?? '计划';
  const tag = current ? PLAN_STATUS_LABELS[current.status] : '已被新的计划取代';
  const meta = current
    ? current.status === 'executing'
      ? `已完成 ${current.steps.filter((s) => s.done).length}/${current.steps.length} 步`
      : `${current.steps.length} 步 · 第 ${current.rev} 版`
    : '';

  return (
    <ConvCard
      label="Plan"
      icon={ListChecks}
      tag={tag}
      data-testid="plan-summary-card"
      footer={
        <>
          <span className={styles.meta}>{meta}</span>
          <Button
            data-testid="plan-summary-open"
            disabled={!current}
            icon={<PanelRight size={14} />}
            onClick={() => openPlanDockTab(owner)}
            size="small"
          >
            打开计划面板
          </Button>
        </>
      }
    >
      <div className={styles.title}>{title}</div>
    </ConvCard>
  );
});

/** 规划回合结束却没有调用 upsert_plan：显式失败提示，不回退到解析正文。 */
export const PlanMissingNotice = memo(function PlanMissingNotice({ content }: { content: string }) {
  return (
    <div className={styles.missing} data-testid="plan-missing">
      <AlertTriangle size={14} style={{ flex: 'none', marginTop: 4 }} />
      <span>{content}</span>
    </div>
  );
});
