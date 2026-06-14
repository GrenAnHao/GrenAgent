import { Block, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronRight, Loader2, Network } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCardStyles } from '../tools/cardStyles';
import { SubAgentConversation } from '../panels/SubAgentConversation';

const styles = createStaticStyles(({ css }) => ({
  head: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    cursor: pointer;
    user-select: none;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  title: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  strong: css`
    color: ${cssVar.colorText};
    font-weight: 600;
  `,
  chev: css`
    flex: none;
    display: inline-flex;
    color: ${cssVar.colorTextQuaternary};
    transition: transform 0.15s;
  `,
  chevOpen: css`
    transform: rotate(90deg);
  `,
  nested: css`
    margin-block-start: 4px;
    margin-inline-start: 11px;
    padding-inline-start: 16px;
    border-inline-start: 2px solid ${cssVar.colorBorderSecondary};
  `,
}));

interface SubAgentInlineProps {
  index: number;
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

/**
 * 流内内联子代理：可折叠外壳（Network 状态块 + 「子代理 #N · 任务」+ chevron），
 * 展开为左侧细线缩进的嵌套子会话（复用 SubAgentConversation）。运行中自动展开 + shimmer，
 * 完成后自动收起为摘要（用户仍可手动切换）。右侧 RightPanel 深看入口保持不变。
 */
export function SubAgentInline({ index, task, result, status }: SubAgentInlineProps) {
  const { styles: card } = useCardStyles();
  const [open, setOpen] = useState(status === 'running');

  useEffect(() => {
    setOpen(status === 'running');
  }, [status]);

  const running = status === 'running';
  const color =
    status === 'done'
      ? cssVar.colorSuccess
      : status === 'error'
        ? cssVar.colorError
        : cssVar.colorTextSecondary;

  return (
    <div data-testid="subagent-inline">
      <div className={styles.head} onClick={() => setOpen((v) => !v)}>
        <Block
          horizontal
          align="center"
          justify="center"
          variant="outlined"
          style={{ flex: 'none', width: 24, height: 24, color }}
        >
          <Icon icon={running ? Loader2 : Network} size={14} spin={running} />
        </Block>
        <span className={cx(styles.title, running && card.shinyText)}>
          <b className={styles.strong}>子代理 #{index}</b> · {task}
          {running ? '（运行中…）' : ''}
        </span>
        <span className={cx(styles.chev, open && styles.chevOpen)}>
          <Icon icon={ChevronRight} size={16} />
        </span>
      </div>
      {open ? (
        <div className={styles.nested}>
          <SubAgentConversation task={task} result={result} status={status} />
        </div>
      ) : null}
    </div>
  );
}
