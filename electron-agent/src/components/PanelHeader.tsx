import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';

/** 所有列顶部 header 的统一高度（侧栏/主列/右栏/终端共用，保证各列顶部对齐）。 */
export const HEADER_HEIGHT = 44;

const styles = createStaticStyles(({ css }) => ({
  bar: css`
    flex: 0 0 auto;
    height: ${HEADER_HEIGHT}px;
    padding-inline: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    /* 透明继承所在列底色（侧栏/内容），避免顶栏悬浮成更亮的色块、与列身割裂。 */
    background: transparent;
  `,
  title: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

interface PanelHeaderProps {
  /** 左侧内容（如折叠/展开按钮），显示在标题之前。 */
  left?: ReactNode;
  /** 标题；传入 string 时套用统一标题样式。 */
  title?: ReactNode;
  /** 右侧操作区图标。 */
  actions?: ReactNode;
}

/** 左栏/主列/右栏共用的面板头部：统一高度、内边距、底边框与图标间距。 */
export function PanelHeader({ left, title, actions }: PanelHeaderProps) {
  return (
    <Flexbox horizontal align="center" distribution="space-between" className={styles.bar}>
      <Flexbox horizontal align="center" gap={8}>
        {left}
        {typeof title === 'string' ? <span className={styles.title}>{title}</span> : title}
      </Flexbox>
      {actions != null && (
        <Flexbox horizontal align="center" gap={4}>
          {actions}
        </Flexbox>
      )}
    </Flexbox>
  );
}
