import { Accordion, AccordionItem, Flexbox, ScrollArea, Text } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { useEffect, useState } from 'react';
import { LazyMarkdown } from './LazyMarkdown';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useCardStyles } from '../tools/cardStyles';
import { StatusIndicator } from '../tools/StatusIndicator';

const useStyles = createStyles(({ css, cssVar }) => ({
  body: css`
    max-height: min(40vh, 320px);
    padding-inline: 4px;
    color: ${cssVar.colorTextTertiary};

    /* 推理正文整体走浅色，弱于正式回答 */
    *,
    article * {
      color: ${cssVar.colorTextTertiary};
    }
  `,
  scrollRoot: css`
    border-radius: 0;
    background: transparent;
  `,
}));

interface ThinkingProps {
  /** 推理正文（markdown）。 */
  content: string;
  /** 是否正在推理（streaming 且正文尚未开始）。 */
  thinking: boolean;
  /** 推理耗时（ms），完成后显示「用时 X 秒」。 */
  duration?: number;
}

/** 深度思考折叠块：对齐 lobehub —— 原子/loading 图标 + shimmer/用时文案 + 浅色 markdown 正文 + 限高滚动 + 推理中自动展开。 */
export function Thinking({ content, thinking, duration }: ThinkingProps) {
  const hasContent = content.trim().length > 0;
  const { styles } = useStyles();
  const { styles: card } = useCardStyles();
  const [showDetail, setShowDetail] = useState(thinking);

  // 推理中自动展开，结束后自动收起；中途用户仍可手动切换。
  useEffect(() => {
    setShowDetail(thinking);
  }, [thinking]);

  // 推理流式中正文自动滚底（对齐 lobehub Thinking 的 useAutoScroll，阈值 120）。
  const { ref: bodyRef, handleScroll } = useAutoScroll<HTMLDivElement>({
    deps: [content, showDetail],
    enabled: thinking && showDetail,
    threshold: 120,
  });

  if (!hasContent) return null;

  const title = (
    <Flexbox horizontal align="center" gap={6}>
      <StatusIndicator status={thinking ? 'running' : 'thinking'} />
      {thinking ? (
        <span className={card.shinyText}>深度思考中…</span>
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {duration ? `已深度思考（用时 ${(duration / 1000).toFixed(1)} 秒）` : '已深度思考'}
        </Text>
      )}
    </Flexbox>
  );

  return (
    <Accordion
      disableAnimation
      gap={4}
      variant="borderless"
      expandedKeys={showDetail ? ['thinking'] : []}
      onExpandedChange={(keys) => setShowDetail(keys.includes('thinking'))}
    >
      <AccordionItem itemKey="thinking" paddingBlock={4} paddingInline={4} title={title}>
        <ScrollArea
          disableContentFit
          scrollFade
          className={styles.scrollRoot}
          contentProps={{
            style: {
              color: 'inherit',
              display: 'block',
              fontSize: 'inherit',
              gap: 0,
              lineHeight: 'inherit',
            },
          }}
          viewportProps={{
            ref: bodyRef,
            className: styles.body,
            onScroll: handleScroll,
          }}
        >
          <LazyMarkdown variant="chat" fontSize={13} animated={thinking}>
            {content}
          </LazyMarkdown>
        </ScrollArea>
      </AccordionItem>
    </Accordion>
  );
}
