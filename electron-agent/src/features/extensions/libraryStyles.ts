import { createStaticStyles, cssVar } from 'antd-style';

/** 命令页签和规则页签共用：左列表、右编辑。 */
export const libraryStyles = createStaticStyles(({ css }) => ({
  split: css`
    display: grid;
    grid-template-columns: 188px minmax(0, 1fr);
    flex: 1;
    min-height: 560px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: var(--gren-content-bg, ${cssVar.colorBgContainer});

    @container extension-content (max-width: 680px) {
      grid-template-columns: minmax(0, 1fr);

      &[data-mobile-detail='true'] > [data-library-list],
      &[data-mobile-detail='false'] > [data-library-editor] {
        display: none;
      }
    }
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 8px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
    background: color-mix(in srgb, var(--gren-sidebar-bg, ${cssVar.colorBgLayout}) 72%, var(--gren-content-bg, ${cssVar.colorBgContainer}));

    @container extension-content (max-width: 680px) {
      border-inline-end: 0;
    }
  `,
  filters: css`
    margin: 0 4px 10px;
  `,
  item: css`
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 12px 10px;
    border: 0;
    border-radius: 7px;
    text-align: start;
    color: ${cssVar.colorText};
    background: transparent;
    cursor: pointer;

    &[data-active='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  itemTop: css`
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    width: 100%;

    & > :first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    & > [data-command] {
      padding: 1px 6px;
      border: 1px solid ${cssVar.colorBorderSecondary};
      border-radius: 5px;
      background: ${cssVar.colorBgContainer};
      font-size: 12px;

      > span { color: ${cssVar.colorText}; font-weight: 500; }
    }
  `,
  itemSummary: css`
    overflow: hidden;
    width: 100%;
    font-size: 11px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorTextSecondary};
  `,
  paramCount: css`
    flex: none;
    margin-inline-start: auto;
    font-size: 11px;
    white-space: nowrap;
    color: ${cssVar.colorTextTertiary};
  `,
  rowWrap: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    padding-inline-start: 10px;
    border-radius: 7px;

    &[data-active='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    /* 停用的规则整行变淡，开关本身保持清楚。 */
    &[data-enabled='false'] > button { opacity: 0.55; }
  `,
  rowOpen: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 5px;
    align-items: stretch;
    min-width: 0;
    padding: 13px 10px 13px 0;
    border: 0;
    text-align: start;
    color: ${cssVar.colorText};
    background: transparent;
    cursor: pointer;
  `,
  ellipsis: css`
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  warn: css`
    flex: none;
    color: ${cssVar.colorWarning};
  `,
  param: css`
    padding: 1px 6px;
    border-radius: 4px;
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillTertiary};
  `,
  /** 列表模式范围在来源后面，超长省略。 */
  modesBadge: css`
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,
  ruleMeta: css`
    display: flex;
    gap: 3px;
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
  `,
  /** 编辑区的模式多选：小胶囊，选中用主色。 */
  modePicker: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  `,
  modeChip: css`
    padding: 3px 6px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 5px;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    background: transparent;
    cursor: pointer;

    &[data-active='true'] {
      border-color: ${cssVar.colorPrimaryBorder};
      color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  /** 详情标题旁的「未保存」标记。 */
  dirty: css`
    flex: none;
    margin-inline-end: auto;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 18px;
    color: ${cssVar.colorWarningText};
    background: ${cssVar.colorWarningBg};
  `,
  switchLabel: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
  `,
  scopePath: css`
    margin-block-start: 6px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};

    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  `,  edit: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 19px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 22px 18px;
  `,
  back: css`
    display: none;
    align-items: center;
    align-self: flex-start;
    gap: 6px;
    padding: 0 0 2px;
    border: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    background: transparent;
    cursor: pointer;

    @container extension-content (max-width: 680px) {
      display: inline-flex;
    }
  `,
  editorHeading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;

    h3 {
      min-width: 0;
      margin: 0;
      color: ${cssVar.colorText};
      font-size: 19px;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
  `,
  sectionHeading: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 5px 8px;
    padding-block-end: 9px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    color: ${cssVar.colorText};

    span {
      font-size: 11px;
      color: ${cssVar.colorTextTertiary};
    }
  `,
  formRow: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 13px;

    & > div {
      min-width: 0;
    }

    @container extension-content (max-width: 480px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  fillField: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 180px;
  `,
  fillArea: css`
    flex: 1;
    min-height: 160px;
  `,
  label: css`
    margin-block-end: 6px;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  params: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  footer: css`
    display: flex;
    align-items: center;
    gap: 8px;
    margin-block-start: auto;
    padding-block-start: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  saveButton: css`
    margin-inline-start: auto;
  `,
  error: css`
    font-size: 13px;
    color: ${cssVar.colorError};
  `,
  empty: css`
    padding: 40px 0;
    font-size: 13px;
    text-align: center;
    color: ${cssVar.colorTextTertiary};
  `,
}));
