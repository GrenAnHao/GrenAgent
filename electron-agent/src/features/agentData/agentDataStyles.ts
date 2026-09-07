import { createStaticStyles, cssVar } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgLayout};
  `,
  header: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 52px;
    padding: 10px 24px 0;
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
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorPrimary};
  `,
  title: css`
    margin: 0;
    font-size: 15px;
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
    gap: 8px;
    flex: 0 0 auto;
  `,
  runtime: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 999px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    white-space: nowrap;
  `,
  runtimeDot: css`
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: ${cssVar.colorTextTertiary};
  `,
  runtimeDotReady: css`
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
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    transition: color .15s, border-color .15s;
    &:hover:not(:disabled) { border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorPrimary}; }
    &:disabled { cursor: wait; opacity: 0.55; }
  `,
  /** 与 header 同底色、共用一条下边框，视觉上合成一个头部区块。 */
  nav: css`
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
    gap: 4px;
    min-height: 40px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
    overflow-x: auto;
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
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
    transition: color .15s;
    &:hover { color: ${cssVar.colorText}; }
  `,
  tabActive: css`
    border-block-end-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorPrimary};
    font-weight: 600;
  `,
  error: css`
    flex: 0 0 auto;
    padding: 8px 24px;
    border-block-end: 1px solid ${cssVar.colorErrorBorder};
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: 12px;
    overflow-wrap: anywhere;
  `,
  body: css`
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  `,
  /** 用内边距而非包一层容器来限宽，保证 audit 等 height:100% 的子面板仍能撑满。 */
  panel: css`
    box-sizing: border-box;
    height: 100%;
    min-width: 0;
    overflow: auto;
    padding-block: 20px 32px;
    padding-inline: max(24px, (100% - 1180px) / 2);
    @media (max-width: 800px) { padding-inline: 16px; }
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
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 12px;
    margin-block-end: 16px;
  `,
  card: css`
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 14px 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  cardLabel: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    line-height: 1.4;
  `,
  cardValue: css`
    display: block;
    margin-block-start: 8px;
    overflow: hidden;
    font-size: 26px;
    font-weight: 600;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cardValueCompact: css`
    white-space: normal;
    font-size: 15px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  `,
  cardMeta: css`
    display: block;
    margin-block-start: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
    line-height: 1.5;
  `,
  /** 次级指标：比 KPI 卡片轻一档，避免概览页出现两排等重的方块。 */
  statStrip: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1px;
    margin-block-end: 20px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBorderSecondary};
  `,
  stat: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 12px 16px;
    border: 0;
    background: ${cssVar.colorBgContainer};
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background .15s;
    &:hover { background: ${cssVar.colorFillQuaternary}; }
  `,
  statLabel: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  statValue: css`
    overflow: hidden;
    color: ${cssVar.colorText};
    font-size: 18px;
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  columns: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
    margin-block-end: 20px;
    align-items: start;
  `,
  /** 内容分组卡片：标题栏 + 列表/表格，替代此前直接散落在页面上的 <p><button>。 */
  panelCard: css`
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  panelCardHead: css`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  panelCardTitle: css`
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    min-width: 0;
  `,
  listRow: css`
    display: block;
    width: 100%;
    min-width: 0;
    padding: 10px 16px;
    border: 0;
    border-block-end: 1px solid ${cssVar.colorFillQuaternary};
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background .15s;
    &:last-child { border-block-end: 0; }
    &:hover { background: ${cssVar.colorFillQuaternary}; }
  `,
  listTitle: css`
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    color: ${cssVar.colorText};
    font-size: 13px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  `,
  listMeta: css`
    margin-block-start: 3px;
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  listEmpty: css`
    padding: 24px 16px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    text-align: center;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    th, td { padding: 10px 16px; border-block-end: 1px solid ${cssVar.colorFillQuaternary}; text-align: start; overflow-wrap: anywhere; word-break: normal; line-height: 1.5; }
    th { color: ${cssVar.colorTextTertiary}; font-size: 12px; font-weight: 500; background: ${cssVar.colorFillQuaternary}; }
    td { color: ${cssVar.colorTextSecondary}; }
    td:first-child { color: ${cssVar.colorText}; font-weight: 500; }
    tbody tr:last-child td { border-block-end: 0; }
    tbody tr:hover td { background: ${cssVar.colorFillQuaternary}; }
  `,
  pathSummary: css`
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.5;
  `,
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-block-end: 14px;
  `,
  input: css`
    min-width: 220px;
    flex: 1;
    height: 32px;
    padding-inline: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font-size: 12px;
    outline: none;
    &:focus { border-color: ${cssVar.colorPrimary}; }
  `,
  select: css`
    height: 32px;
    padding-inline: 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    outline: none;
  `,
  progress: css`
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 120px;
    font-variant-numeric: tabular-nums;
  `,
  progressTrack: css`
    width: 72px;
    height: 5px;
    overflow: hidden;
    border-radius: 3px;
    background: ${cssVar.colorFillTertiary};
  `,
  progressBar: css`
    height: 100%;
    border-radius: inherit;
    background: ${cssVar.colorPrimary};
  `,
  statusTag: css`
    display: inline-flex;
    padding: 2px 8px;
    border-radius: 999px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
    white-space: nowrap;
  `,
  statusRunning: css`
    background: ${cssVar.colorSuccessBg};
    color: ${cssVar.colorSuccess};
  `,
  statusFailed: css`
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
  `,
  actionButton: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 32px;
    width: max-content;
    max-width: 100%;
    padding: 3px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    cursor: pointer;
    transition: color .15s, border-color .15s;
    &:hover:not(:disabled) { border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorPrimary}; }
    &:disabled { cursor: not-allowed; opacity: 0.55; }
  `,
  dangerButton: css`
    &:hover:not(:disabled) { border-color: ${cssVar.colorError}; color: ${cssVar.colorError}; }
  `,
  primaryButton: css`
    border-color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorBgContainer};
    &:hover:not(:disabled) { opacity: .88; border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorBgContainer}; }
  `,
  state: css`
    padding: 32px 16px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    text-align: center;
  `,
  metricButton: css`
    width: 100%;
    min-height: 104px;
    justify-content: flex-start;
    text-align: start;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: border-color .15s, box-shadow .15s;
    &:hover { border-color: ${cssVar.colorPrimary}; box-shadow: ${cssVar.boxShadowTertiary}; }
  `,
  textButton: css`
    display: block;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: start;
    &:hover { color: ${cssVar.colorPrimary}; }
  `,
  recentItem: css`
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    line-height: 1.5;
    overflow-wrap: anywhere;
  `,
  inlineError: css`
    color: ${cssVar.colorError};
    font-size: 12px;
    padding-block: 6px;
    overflow-wrap: anywhere;
  `,
  selectedRow: css`
    background: ${cssVar.colorPrimaryBg};
    td { background: ${cssVar.colorPrimaryBg}; }
  `,
}));
