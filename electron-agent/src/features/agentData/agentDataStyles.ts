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
    container: agent-data / inline-size;
  `,
  brand: css`
    display: flex; align-items: center; gap: 8px; margin-inline: 20px 16px; white-space: nowrap; font-weight: 600;
    > i { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; font-style: normal;
      background: ${cssVar.colorPrimaryBg}; color: ${cssVar.colorPrimary}; }
    @container agent-data (max-width: 759px) { > span { display: none; } }
  `,
  runtime: css`display: flex; align-items: center; gap: 8px; margin-inline-end: 20px; white-space: nowrap; color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  tabLabel: css`
    display: inline-flex; align-items: center; gap: 6px;
    @container agent-data (max-width: 759px) {
      [data-tab-text] { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    }
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
    & > .ant-tabs-nav { margin: 0; min-height: 48px; background: ${cssVar.colorBgContainer}; }
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
