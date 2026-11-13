import { createStaticStyles, cssVar } from 'antd-style';

/**
 * 代码结果行：左侧图标 + 右侧「标题 / 路径 / 元信息」分层，扁平行、圆角 hover/选中态，
 * 与侧栏和扩展工作台的列表语言一致。选中态由 aria-pressed 驱动，避免切换 type 重挂载节点、丢失焦点恢复引用。
 * antd Button 给 `.ant-btn` 写死了 white-space: nowrap 与 align-items: center，这里只覆盖布局，颜色仍由 antd 变体决定。
 */
export const listRowStyles = createStaticStyles(({ css }) => ({
  /** 行组不再套外框：面板卡片里再画一个边框盒会显得笨重。 */
  group: css`
    min-width: 0; display: flex; flex-direction: column; gap: 2px;
    margin: 6px;
    &:empty { display: none; }
  `,
  row: css`
    display: flex; flex-direction: row; align-items: flex-start; gap: 10px;
    height: auto; min-width: 0; padding: 7px 10px; border-radius: 8px;
    white-space: normal; text-align: start; overflow-wrap: anywhere;
    &[aria-pressed='true'] {
      background: ${cssVar.colorPrimaryBg};
      box-shadow: inset 2px 0 0 ${cssVar.colorPrimary};
    }
  `,
  icon: css`
    flex: none; display: grid; place-items: center; width: 20px; height: 20px;
    margin-top: 1px; color: ${cssVar.colorTextTertiary};
  `,
  body: css`flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;`,
  /** 行标题单行截断；全文在路径行或详情面板。 */
  title: css`
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13px; line-height: 1.5;
  `,
  path: css`
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 11px; color: ${cssVar.colorTextTertiary}; line-height: 1.5;
  `,
  /** 行内次级元信息（行号、类型、snippet）：一条横向紧凑行，snippet 吃掉剩余宽度。 */
  meta: css`
    display: flex; align-items: center; gap: 8px; min-width: 0;
    font-size: 11px; color: ${cssVar.colorTextTertiary}; line-height: 1.6;
  `,
  metaItem: css`flex: none; min-width: 0;`,
  kind: css`
    flex: none; padding: 0 6px; border-radius: 4px;
    background: ${cssVar.colorFillTertiary}; color: ${cssVar.colorTextSecondary};
    font-size: 10px; line-height: 1.7;
  `,
  snippet: css`
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  `,
}));