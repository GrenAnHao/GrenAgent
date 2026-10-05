import { Icon, ScrollShadow } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { LazyMarkdown } from './LazyMarkdown';

const COLLAPSED_MAX_HEIGHT = 350;
const EXPANDED_MAX_HEIGHT = 550;
const HOVER_BAND = 40;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: relative;
    min-width: 0;
  `,
  content: css`
    padding: 8px 12px;
  `,
  toggle: css`
    position: absolute;
    left: 50%;
    bottom: 6px;
    z-index: 1;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 20px;
    padding: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;
    background: ${cssVar.colorBgElevated};
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
  `,
}));

/** 子代理完整任务提示词：收起最多 350px、底部阴影；展开最多 550px，不满则跟着内容。 */
export function TaskPromptFrame({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [hot, setHot] = useState(false);

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHot(box.bottom - e.clientY <= HOVER_BAND);
  };

  return (
    <div
      className={styles.root}
      data-testid="task-prompt-frame"
      data-expanded={expanded ? 'true' : 'false'}
      onMouseMove={onMove}
      onMouseLeave={() => setHot(false)}
    >
      <ScrollShadow
        orientation="vertical"
        hideScrollBar={!expanded}
        visibility={expanded ? 'never' : 'auto'}
        size={32}
        style={
          expanded
            ? { maxHeight: EXPANDED_MAX_HEIGHT, overflowY: 'auto' }
            : { maxHeight: COLLAPSED_MAX_HEIGHT, overflowY: 'hidden' }
        }
      >
        <div className={styles.content}>
          <LazyMarkdown variant="chat" tone="secondary">
            {text}
          </LazyMarkdown>
        </div>
      </ScrollShadow>
      {hot ? (
        <button
          type="button"
          className={styles.toggle}
          aria-label={expanded ? '收起任务提示词' : '展开任务提示词'}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon icon={expanded ? ChevronUp : ChevronDown} size={14} />
        </button>
      ) : null}
    </div>
  );
}
