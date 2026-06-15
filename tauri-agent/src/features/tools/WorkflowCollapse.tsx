import { Accordion, AccordionItem, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Suspense, lazy, useState } from 'react';
import { StatusIndicator } from './StatusIndicator';
import { useCardStyles } from './cardStyles';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import type { AssistantToolItem } from '../chat/AssistantMessage';

const ToolExecution = lazy(() =>
  import('./ToolExecution').then((m) => ({ default: m.ToolExecution })),
);

const styles = createStaticStyles(({ css }) => ({
  list: css`
    margin-block-start: 4px;
    margin-inline-start: 11px;
    padding-inline-start: 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
    display: flex;
    flex-direction: column;
    gap: 2px;

    /* 展开限高 + 滚动（对齐 lobe constrained）：多工具时不撑爆对话流。 */
    max-height: min(50vh, 480px);
    overflow-y: auto;
    scrollbar-width: thin;
  `,
  summary: css`
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

/**
 * 多工具总折叠：对齐 lobe-chat —— 真 Accordion + 状态块（NeuralNetworkLoading / Check / X）
 * + 摘要（运行中 shimmer），展开为左侧细线缩进的逐工具列表（各自仍可展开详情）。
 */
export function WorkflowCollapse({ tools }: { tools: AssistantToolItem[] }) {
  const { styles: card } = useCardStyles();
  const [open, setOpen] = useState(false);

  const running = tools.some((t) => t.status === 'running');
  const errored = tools.some((t) => t.status === 'error');
  const status = running ? 'running' : errored ? 'error' : 'done';
  const done = tools.filter((t) => t.status === 'done').length;

  // 运行中跟随滚底（对齐 lobe constrained 的 useAutoScroll）。
  const { ref: listRef, handleScroll } = useAutoScroll<HTMLDivElement>({
    deps: [tools.length, done],
    enabled: running && open,
    threshold: 120,
  });

  const title = (
    <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0 }}>
      <StatusIndicator status={status} />
      {running ? (
        <span className={cx(card.shinyText, styles.summary)}>
          正在运行工具…（{done}/{tools.length}）
        </span>
      ) : (
        <Text className={styles.summary} type="secondary">
          运行了 {tools.length} 个工具
        </Text>
      )}
    </Flexbox>
  );

  return (
    <Accordion
      disableAnimation
      gap={4}
      variant="borderless"
      expandedKeys={open ? ['workflow'] : []}
      onExpandedChange={(keys) => setOpen(keys.includes('workflow'))}
    >
      <AccordionItem itemKey="workflow" paddingBlock={4} paddingInline={4} title={title}>
        <div ref={listRef} className={styles.list} onScroll={handleScroll}>
          <Suspense fallback={null}>
            {tools.map((t) => (
              <ToolExecution
                key={t.id}
                toolName={t.toolName}
                toolCallId={t.toolCallId}
                args={t.args}
                result={t.result}
                status={t.status}
              />
            ))}
          </Suspense>
        </div>
      </AccordionItem>
    </Accordion>
  );
}
