import { createStaticStyles, cssVar } from 'antd-style';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: ${cssVar.colorText};
  `,
  header: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 58px;
    padding: 10px 18px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  identity: css`
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  `,
  icon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    border-radius: 7px;
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorPrimary};
  `,
  title: css`
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
  `,
  subtitle: css`
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  headerActions: css`
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  `,
  runtime: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  runtimeDot: css`
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: ${cssVar.colorSuccess};
  `,
  runtimeDotClosed: css`
    background: ${cssVar.colorWarning};
  `,
  iconButton: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    &:hover { border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorPrimary}; }
    &:disabled { cursor: wait; opacity: 0.55; }
  `,
  nav: css`
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
    gap: 2px;
    min-height: 42px;
    padding-inline: 14px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
    overflow-x: auto;
  `,
  tab: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: max-content;
    padding: 0 10px;
    border: 0;
    border-block-end: 2px solid transparent;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    cursor: pointer;
    &:hover { color: ${cssVar.colorText}; }
  `,
  tabActive: css`
    border-block-end-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorText};
    font-weight: 600;
  `,
  error: css`
    flex: 0 0 auto;
    padding: 8px 18px;
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  body: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 20px 18px 32px;
  `,
  content: css`
    width: 100%;
    max-width: 980px;
    margin-inline: auto;
  `,
  sectionHeading: css`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-block: 0 12px;
  `,
  heading: css`
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  `,
  hint: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  kpis: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-block-end: 24px;
    @media (max-width: 760px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  `,
  card: css`
    min-width: 0;
    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 7px;
    background: ${cssVar.colorBgContainer};
  `,
  cardLabel: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  cardValue: css`
    margin-block-start: 8px;
    overflow: hidden;
    font-size: 24px;
    font-weight: 600;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cardMeta: css`
    margin-block-start: 8px;
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
  `,
  statusGrid: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-block-end: 24px;
    @media (max-width: 680px) { grid-template-columns: 1fr; }
  `,
  statusRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-block: 7px;
    border-block-end: 1px solid ${cssVar.colorFillQuaternary};
    &:last-child { border-block-end: 0; }
  `,
  statusName: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  statusValue: css`
    color: ${cssVar.colorText};
    font-family: ${mono};
    font-size: 11px;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    th, td { padding: 9px 10px; border-block-end: 1px solid ${cssVar.colorBorderSecondary}; text-align: start; }
    th { color: ${cssVar.colorTextTertiary}; font-size: 11px; font-weight: 500; }
    td { color: ${cssVar.colorTextSecondary}; }
    td:first-child { color: ${cssVar.colorText}; font-weight: 500; }
  `,
  state: css`
    padding: 36px 16px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 7px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    text-align: center;
  `,
}));
