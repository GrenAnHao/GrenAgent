import { createStaticStyles, cssVar } from 'antd-style';

/**
 * antd Button 充当多行列表行（概览最近项、Memory 列表、代码结果行）的共同布局。
 *
 * antd 给 `.ant-btn` 写死了 `white-space: nowrap` 与 `align-items: center`，堆叠内容会被压成
 * 一行横向溢出；这里只覆盖布局，颜色仍由 antd 变体决定。antd 样式表 prepend 在 head 顶部，
 * 同优先级下此处的类总能覆盖。选中态由 aria-pressed 驱动，避免切换 type 重挂载节点、丢失焦点恢复引用。
 * 同一份类也可用于不可点击的普通容器，保证可点与不可点的行对齐一致。
 */
export const listRowStyles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 3px;
    height: auto;
    min-width: 0;
    padding: 10px 16px;
    white-space: normal;
    text-align: start;
    overflow-wrap: anywhere;
    &[aria-pressed='true'] {
      border-color: ${cssVar.colorPrimaryBorder};
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  /** 容器内平铺的行：去圆角，相邻行以细线分隔。 */
  flush: css`
    border-radius: 0;
    & + & { border-block-start: 1px solid ${cssVar.colorFillQuaternary}; }
  `,
  /** 行标题两行截断；全文放在 title 或详情面板。 */
  title: css`
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    line-height: 1.5;
  `,
  /** 平铺行的外框：与详情面板同一套边框、圆角与底色；空列表时不留一条孤线。 */
  group: css`
    min-width: 0;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    &:empty { display: none; }
  `,
}));
