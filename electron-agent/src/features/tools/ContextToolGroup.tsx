import { Accordion, AccordionItem, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Suspense, lazy, memo, useState } from 'react';
import { StatusIndicator } from './StatusIndicator';
import { cardStyles } from './cardStyles';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { contextToolCategory } from './toolUtils';
import type { ToolSegment } from '../chat/groupMessages';

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
  fail: css`
    color: ${cssVar.colorWarning};
    font-weight: 600;
  `,
}));

/** 把上下文工具计数拼成中文摘要，省略为 0 的类别。 */
function summarize(tools: ToolSegment[]): string {
  let read = 0;
  let list = 0;
  for (const t of tools) {
    if (contextToolCategory(t.toolName) === 'list') list++;
    else read++;
  }
  const parts: string[] = [];
  if (read) parts.push(`${read} 个文件`);
  if (list) parts.push(`${list} 个目录`);
  return parts.join(' · ');
}

/**
 * 连续查找类工具折叠：对齐 MiMo 的 ContextToolGroup —— 收起时一条「已收集上下文 · 摘要」，
 * 展开为逐工具列表（各自仍可看详情）。始终停留在时间线里的真实位置。
 */
function ContextToolGroupInner({ tools }: { tools: ToolSegment[] }) {
  const card = cardStyles;
  const [open, setOpen] = useState(false);

  const running = tools.some((t) => t.status === 'running');
  const errorCount = tools.filter((t) => t.status === 'error').length;
  const done = tools.filter((t) => t.status !== 'running').length;
  const status: 'running' | 'done' | 'error' | 'partial' = running
    ? 'running'
    : errorCount === 0
      ? 'done'
      : errorCount === tools.length
        ? 'error'
        : 'partial';

  const { ref: listRef, handleScroll } = useAutoScroll<HTMLDivElement>({
    deps: [tools.length, done],
    enabled: running && open,
    threshold: 120,
  });

  const summary = summarize(tools);

  const title = (
    <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0 }}>
      <StatusIndicator status={status} />
      {running ? (
        <span className={cx(card.shinyText, styles.summary)}>
          正在收集上下文…（{done}/{tools.length}）
        </span>
      ) : status === 'partial' ? (
        <Text className={styles.summary} type="secondary">
          已收集上下文 · {summary} <span className={styles.fail}>· {errorCount} 个失败</span>
        </Text>
      ) : status === 'error' ? (
        <Text className={styles.summary} type="secondary">
          收集上下文失败（{tools.length}）
        </Text>
      ) : (
        <Text className={styles.summary} type="secondary">
          已收集上下文{summary ? ` · ${summary}` : ''}
        </Text>
      )}
    </Flexbox>
  );

  return (
    <Accordion
      disableAnimation
      gap={4}
      variant="borderless"
      expandedKeys={open ? ['context'] : []}
      onExpandedChange={(keys) => setOpen(keys.includes('context'))}
    >
      <AccordionItem itemKey="context" paddingBlock={4} paddingInline={0} title={title}>
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

export const ContextToolGroup = memo(ContextToolGroupInner, (prev, next) => {
  const a = prev.tools;
  const b = next.tools;
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].status !== b[i].status ||
      a[i].args !== b[i].args ||
      a[i].result !== b[i].result
    ) {
      return false;
    }
  }
  return true;
});
