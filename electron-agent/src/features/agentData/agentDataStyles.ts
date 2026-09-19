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
  /**
   * Tabs 作为主体容器：nav 在顶，内容区撑满剩余高度，滚动发生在 panel 内。
   * antd v6 的 Tabs 结构是 .ant-tabs-body-holder > .ant-tabs-body > .ant-tabs-content（面板），
   * 不是 v5 的 content-holder / content / tabpane；只用子代选择器，免得波及面板里嵌套的 Tabs。
   */
  bodyTabs: css`
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    & > .ant-tabs-body-holder { flex: 1; min-height: 0; overflow: hidden; }
    & > .ant-tabs-body-holder > .ant-tabs-body { height: 100%; }
    & > .ant-tabs-body-holder > .ant-tabs-body > .ant-tabs-content { height: 100%; }
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
  kpis: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 12px;
    margin-block-end: 16px;
  `,
  /** 次级指标条：比 KPI 卡片轻一档，避免概览页出现两排等重的方块。 */
  statCard: css`
    margin-block-end: 20px;
    overflow: hidden;
  `,
  /** 1px 网格缝透出卡片底下的分隔色，替代每格画边框。 */
  statStrip: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1px;
    background: ${cssVar.colorBorderSecondary};
  `,
  stat: css`
    padding: 12px 16px;
    border-radius: 0;
    background: ${cssVar.colorBgContainer};
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
  /** 内容分组卡片：卡片体直接铺列表行，行的方角不能盖过卡片圆角。 */
  listCard: css`
    overflow: hidden;
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
  selectedRow: css`
    background: ${cssVar.colorPrimaryBg};
    td { background: ${cssVar.colorPrimaryBg}; }
  `,
}));
