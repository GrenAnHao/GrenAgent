import { createStaticStyles, cssVar } from 'antd-style';

/** WorkspaceBar 及其弹层（分支 / diff / 图谱 / 任务）共享样式。无 emoji，配色走 antd token。 */
export const wsStyles = createStaticStyles(({ css }) => ({
  bar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-bottom: 8px;
  `,
  projectContextPanel: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    background: ${cssVar.colorBgContainer};
  `,
  projectContextPanelHeader: css`
    display: grid;
    gap: 2px;
    padding: 14px 16px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 14px;
    color: ${cssVar.colorText};
  `,
  projectContextPanelPath: css`
    overflow: hidden;
    font-size: 11px;
    font-weight: 400;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  projectContextPanelMessage: css`
    padding: 16px;
    color: ${cssVar.colorError};
  `,
  projectContextTabList: css`
    display: flex;
    gap: 2px;

    padding: 8px 12px 0;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    overflow-x: auto;
  `,
  projectContextTab: css`
    flex: none;
    min-height: 34px;
    padding: 0 10px;
    border: 0;
    border-bottom: 2px solid transparent;

    font-size: 12.5px;
    color: ${cssVar.colorTextSecondary};
    background: transparent;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: -2px;
    }
  `,
  projectContextTabActive: css`
    border-bottom-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorPrimary};
    font-weight: 600;
  `,
  projectContextTabPanel: css`
    flex: 1;
    min-height: 0;
    padding: 16px;
    overflow: auto;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  projectContextStack: css`
    display: grid;
    gap: 10px;
  `,
  projectContextOverview: css`
    display: grid;
    gap: 8px;

    > div {
      display: grid;
      gap: 2px;
      padding: 10px;
      border: 1px solid ${cssVar.colorBorderSecondary};
      border-radius: 6px;
    }

    span { color: ${cssVar.colorTextTertiary}; font-size: 12px; }
  `,
  projectContextResult: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};

    > div { display: grid; gap: 3px; min-width: 0; }
    span { color: ${cssVar.colorTextTertiary}; font-size: 12px; }
  `,
  projectContextSearch: css`
    display: flex;
    gap: 8px;
  `,
  projectContextCode: css`
    margin: 0;
    padding: 10px;
    border-radius: 6px;
    overflow: auto;
    white-space: pre-wrap;
    color: ${cssVar.colorText};
    background: ${cssVar.colorFillQuaternary};
  `,
  projectContextEmpty: css`
    color: ${cssVar.colorTextTertiary};
  `,
  projectContextNotice: css`
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  chip: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;

    height: 28px;
    padding: 0 9px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    font-size: 12.5px;
    color: ${cssVar.colorText};
    white-space: nowrap;

    background: ${cssVar.colorBgElevated};

    user-select: none;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background 0.15s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  chipReadonly: css`
    cursor: default;
    &:hover {
      border-color: ${cssVar.colorBorderSecondary};
      background: ${cssVar.colorBgElevated};
    }
  `,
  chipName: css`
    overflow: hidden;
    max-width: 160px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  muted: css`
    color: ${cssVar.colorTextSecondary};
  `,
  badge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;

    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    border-radius: 9px;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    font-weight: 600;
    /* 中性计数色：colorPrimaryBg 在暗色模式下偏闷、与 chip 撞色不好看，改用中性 fill + 次级文字色，明暗两套都干净。 */
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillSecondary};
  `,
  badgeRun: css`
    color: ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
  `,
  dot: css`
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: ${cssVar.colorSuccess};
  `,
  panel: css`
    display: flex;
    flex-direction: column;

    width: 280px;
    max-height: 380px;
    margin: -4px;
  `,
  panelWide: css`
    width: 460px;
  `,
  search: css`
    display: flex;
    gap: 8px;
    align-items: center;

    padding: 8px 10px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};

    color: ${cssVar.colorTextTertiary};

    input {
      all: unset;
      flex: 1;
      font-size: 12.5px;
      color: ${cssVar.colorText};
    }
  `,
  list: css`
    scrollbar-width: thin;
    overflow-y: auto;
    flex: 1;
    padding: 4px;
  `,
  row: css`
    display: flex;
    gap: 9px;
    align-items: center;

    padding: 7px 10px;
    border-radius: 6px;

    font-size: 13px;
    color: ${cssVar.colorText};

    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  rowSel: css`
    background: ${cssVar.colorPrimaryBg};
  `,
  rowName: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rowSub: css`
    margin-top: 2px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  iconMuted: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
  `,
  foot: css`
    padding: 4px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
  `,
  footRow: css`
    display: flex;
    gap: 9px;
    align-items: center;

    padding: 7px 10px;
    border-radius: 6px;

    font-size: 13px;
    color: ${cssVar.colorPrimary};

    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  empty: css`
    padding: 20px;
    font-size: 12.5px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
  `,
}));
