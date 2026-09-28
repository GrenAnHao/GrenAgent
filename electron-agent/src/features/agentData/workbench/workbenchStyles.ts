import { createStaticStyles, cssVar } from 'antd-style';

export const workbenchStyles = createStaticStyles(({ css }) => ({
  header: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    min-height: 40px; margin-block-end: 12px;
    h2 { margin: 0; font-size: 16px; font-weight: 600; }
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
    gap: 10px; min-height: 260px; color: ${cssVar.colorTextQuaternary}; text-align: center;
  `,
  detailHeader: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block-end: 12px;
    h3 { margin: 0; font-size: 16px; }
  `,
  meta: css`display: flex; flex-wrap: wrap; gap: 6px 14px; margin-block-end: 14px; color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  spacer: css`margin-inline-start: auto;`,
}));
