import { createStaticStyles, cssVar } from 'antd-style';

/**
 * 运营类面板（任务/审计）只保留容器布局与无法用 antd 组件表达的少量结构样式；
 * 控件外观、状态标签、错误提示、表格列宽一律交给 antd 组件自身。
 */
export const operationsStyles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0;
  `,
  auditRoot: css`display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;`,
  /** 审计子页的滚动区：父级 Tabs 面板是定高块级元素，用 height 而不是 flex 撑满。 */
  scrollPanel: css`height: 100%; min-width: 0; overflow: auto;`,
  /** 审计「详情」单元格：横向排布展开与复制，避免继承抽屉详情的纵向大间距。 */
  auditDetail: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    details { min-width: 0; }
    summary { cursor: pointer; color: ${cssVar.colorTextSecondary}; }
    pre { margin: 8px 0 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: ${cssVar.colorFillQuaternary}; border-radius: 6px; font-size: 11px; }
  `,
  section: css`display: flex; flex-direction: column; gap: 12px; align-items: start; margin-block-start: 16px;`,
  /** 行内操作：默认隐藏，行 hover/focus 时显现；触屏设备始终可见。 */
  rowActions: css`
    display: inline-flex; gap: 4px; opacity: 0;
    tr:hover &, tr:focus-within & { opacity: 1; }
    @media (hover: none) { opacity: 1; }
  `,
  /** 筛选下拉按选项内容撑开，避免路径/名称被截成 memory_extr... */
  filterPopup: css`
    .ant-select-item-option-content {
      overflow: visible;
      text-overflow: unset;
      white-space: nowrap;
    }
  `,
}));
