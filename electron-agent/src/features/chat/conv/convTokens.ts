import { createStaticStyles, cssVar } from 'antd-style';

/** 对话项统一设计 token（零运行时；切主题只换 cssVar 值）。所有视觉数值集中于此。 */
export const conv = {
  gap: { xs: 4, sm: 6, md: 8, lg: 10 },
  rowH: 26,
  stripH: 30,
  headH: 28,
} as const;

export const convStyles = createStaticStyles(({ css }) => ({
  // L4/L3 共享 surface：横条 / 卡片 / 用户气泡 / 代码框 同底 + hairline + 圆角
  surface: css`
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  mono: css`
    font-family: ${cssVar.fontFamilyCode};
    font-feature-settings: 'liga' 0;
  `,
  // 行首 lead 槽（状态图标固定宽度，保证名称左缘对齐）
  lead: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 16px;
  `,
}));
