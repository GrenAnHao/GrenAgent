import { createStaticStyles, cssVar } from 'antd-style';

export const dockCard = createStaticStyles(({ css }) => ({
  card: css`
    padding: 6px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillTertiary};
  `,
}));
