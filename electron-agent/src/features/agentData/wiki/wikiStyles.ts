import { createStaticStyles, cssVar } from 'antd-style';

export const wikiStyles = createStaticStyles(({ css }) => ({
  root: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    padding: max(24px, calc((100% - 1180px) / 2));
    padding-block-start: 16px;
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgLayout};
    [hidden] { display: none !important; }
    button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 3px;
    }
  `,
  header: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 20px;
    margin-block-end: 16px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    border: 1px solid ${cssVar.colorBorderSecondary};
    & > div:first-child {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    h3 {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
      line-height: 1.3;
    }
    p {
      margin: 0;
      font-size: 13px;
      color: ${cssVar.colorTextSecondary};
      overflow-wrap: anywhere;
    }
  `,
  headerTitle: css`
    display: flex;
    align-items: center;
    gap: 12px;
  `,
  headerMeta: css`
    display: flex;
    align-items: center;
    gap: 16px;
    margin-block-start: 8px;
    padding-block-start: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  toolbar: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    flex: 0 0 auto;
  `,
  tabs: css`
    display: flex;
    gap: 0;
    margin-block-end: 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    button {
      padding: 10px 16px;
      border: none;
      background: transparent;
      color: ${cssVar.colorTextSecondary};
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.2s;
      &[aria-selected='true'] {
        color: ${cssVar.colorPrimary};
        border-bottom-color: ${cssVar.colorPrimary};
      }
      &:hover {
        color: ${cssVar.colorPrimary};
      }
    }
  `,
  muted: css`color: ${cssVar.colorTextSecondary}; font-size: 12px; overflow-wrap: anywhere;`,
  listHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-block-end: 16px;
    h3 {
      margin: 0 0 4px;
      font-size: 18px;
      font-weight: 600;
    }
  `,
  listToolbar: css`
    display: flex;
    align-items: center;
    gap: 10px;
    margin-block-end: 16px;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  library: css`
    padding: 16px 18px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    border: 1px solid ${cssVar.colorBorderSecondary};
    cursor: pointer;
    transition: all 0.2s;
    &:hover {
      border-color: ${cssVar.colorPrimary};
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
  `,
  libraryHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-block-end: 8px;
  `,
  libraryName: css`
    padding: 0;
    border: none;
    background: transparent;
    font-size: 15px;
    font-weight: 600;
    color: ${cssVar.colorText};
    cursor: pointer;
    text-align: left;
    &:hover {
      color: ${cssVar.colorPrimary};
    }
  `,
  libraryMeta: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-block-start: 10px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    & > span {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
  `,
  workspace: css`
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 16px;
    flex: 1;
    min-height: 0;
    @container (max-width: 799px) {
      grid-template-columns: minmax(0, 1fr);
      &[data-detail='true'] > [data-wiki-list] { display: none; }
      &[data-detail='false'] > [data-wiki-detail] { display: none; }
    }
  `,
  sidebar: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding: 16px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    border: 1px solid ${cssVar.colorBorderSecondary};
    align-self: start;
  `,
  sidebarActions: css`
    display: flex;
    gap: 8px;
    padding-block-end: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  resourceList: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: -4px;
    padding: 4px;
  `,
  resource: css`
    text-align: start;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: ${cssVar.borderRadius};
    color: ${cssVar.colorText};
    background: transparent;
    font: inherit;
    cursor: pointer;
    overflow-wrap: anywhere;
    transition: all .15s;
    &[aria-pressed='true'] {
      background: ${cssVar.colorPrimaryBg};
      border-color: ${cssVar.colorPrimaryBorder};
    }
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
    small {
      display: block;
      margin-block-start: 6px;
      color: ${cssVar.colorTextSecondary};
      font-size: 11px;
    }
  `,
  detail: css`
    min-width: 0;
    padding: 18px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    border: 1px solid ${cssVar.colorBorderSecondary};
  `,
  emptyState: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 400px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
    font-size: 13px;
  `,
  properties: css`display: none;`,
  propertyButton: css`display: inline-flex;`,
  document: css`width: 100%; max-width: 760px; margin-inline: auto; line-height: 1.65; overflow-wrap: anywhere; pre { white-space: pre-wrap; overflow-wrap: anywhere; } img { max-width: 100%; }`,
  editor: css`display: flex; flex-direction: column; gap: 12px; min-width: 0;`,
  preview: css`padding: 16px; min-height: 100px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px; background: ${cssVar.colorBgContainer};`,
  field: css`display: flex; flex-direction: column; gap: 6px; margin-block: 12px;`,
  diagnostics: css`padding: 12px; margin-block: 12px; border: 1px solid ${cssVar.colorWarningBorder}; border-radius: 6px; overflow-wrap: anywhere; background: ${cssVar.colorWarningBg};`,
}));
