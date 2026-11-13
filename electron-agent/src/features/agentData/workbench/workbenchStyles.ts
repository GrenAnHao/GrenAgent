import { createStaticStyles, cssVar } from 'antd-style';

export const workbenchStyles = createStaticStyles(({ css }) => ({
  header: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
    min-height: 40px; margin-block-end: 16px;
    h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  `,
  subtitle: css`color: ${cssVar.colorTextTertiary}; font-size: 13px;`,
  actions: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-inline-start: auto;`,
  banner: css`margin-block-end: 12px;`,
  panel: css`
    display: flex; flex-direction: column; min-width: 0; min-height: 0;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  panelToolbar: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    min-height: 46px; padding: 8px 12px; border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary};
  `,
  split: css`
    container: workbench-split / inline-size;
    display: grid; grid-template-columns: 280px minmax(0, 1fr); flex: 1; min-height: 440px; min-width: 0;
    > [data-split-side] { overflow: auto; padding: 6px; border-inline-end: 1px solid ${cssVar.colorBorderSecondary}; min-width: 0; }
    > [data-split-main] { overflow: auto; padding: 16px 24px; min-width: 0; }
    @container workbench-split (max-width: 799px) {
      grid-template-columns: minmax(0, 1fr);
      &[data-detail='true'] > [data-split-side] { display: none; }
      &[data-detail='false'] > [data-split-main] { display: none; }
    }
  `,
  empty: css`
    display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center;
    gap: 6px; min-height: 260px; text-align: center;
  `,
  emptyIcon: css`
    display: grid; place-items: center; width: 44px; height: 44px; margin-block-end: 6px;
    border-radius: 50%; background: ${cssVar.colorFillTertiary}; color: ${cssVar.colorTextTertiary};
  `,
  emptyTitle: css`color: ${cssVar.colorTextSecondary}; font-size: 13px; font-weight: 500;`,
  emptyText: css`max-width: 320px; color: ${cssVar.colorTextTertiary}; font-size: 12px; line-height: 1.6;`,
  meta: css`display: flex; flex-wrap: wrap; gap: 6px 14px; margin-block-end: 14px; color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  spacer: css`margin-inline-start: auto;`,
}));
