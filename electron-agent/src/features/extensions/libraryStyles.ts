import { createStaticStyles, cssVar } from 'antd-style';

/** 命令页签和规则页签共用：左列表、右编辑。 */
export const libraryStyles = createStaticStyles(({ css }) => ({
  split: css`
    display: grid;
    grid-template-columns: 188px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};

    &[data-single='true'] { grid-template-columns:minmax(0,1fr); }
    @container extension-content (max-width: 680px) {
      grid-template-columns: minmax(0, 1fr);

      &[data-mobile-detail='true'] > [data-library-list],
      &[data-mobile-detail='false'] > [data-library-editor] {
        display: none;
      }
    }
  `,
  welcome: css`
    display:flex; flex:1; min-height:0; overflow:auto; align-items:center; justify-content:safe center; flex-direction:column; padding:16px 12px; > * { flex-shrink:0; } text-align:center;
    h3 { font-size:var(--gren-font-section); font-weight:600; margin:12px 0 6px; } p { font-size:var(--gren-font-secondary); color:${cssVar.colorTextSecondary}; margin:0 0 16px; }
  `,
  templates: css`
    display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); width:min(560px,100%); gap:10px;
    button { text-align:start; display:grid; grid-template-columns:1fr auto; gap:6px; padding:16px; border:1px solid ${cssVar.colorBorderSecondary}; border-radius:8px; background:${cssVar.colorBgContainer}; color:${cssVar.colorText}; cursor:pointer; }
    button:hover,button:focus-visible { border-color:${cssVar.colorPrimary}; }
    code { font-size:var(--gren-font-body); color:${cssVar.colorPrimaryText}; } small { grid-column:1/-1; font-size:var(--gren-font-secondary); color:${cssVar.colorTextSecondary}; }
    @container extension-content (max-width:380px) { grid-template-columns:1fr; }
  `,
  path: css`font-family:${cssVar.fontFamilyCode}; font-size:var(--gren-font-secondary); color:${cssVar.colorTextSecondary}; overflow-wrap:anywhere;`,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 12px 8px;
    border-inline-end: 1px solid var(--gren-master-divider);
    background: var(--gren-master-bg);

    @container extension-content (max-width: 680px) {
      border-inline-end: 0;
    }
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    > * { flex-shrink: 0; }

  `,
  formScroll: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    overscroll-behavior: contain;
    > * { flex-shrink: 0; }
  `,
  filters: css`
    margin: 0 4px 10px;
  `,
  item: css`
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    padding: 8px 9px;
    border: 1px solid transparent;
    border-radius: 7px;
    text-align: start;
    color: ${cssVar.colorText};
    background: transparent;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
    &[data-active='true'] {
      background: ${cssVar.colorPrimaryBg};
      border-color: ${cssVar.colorPrimaryBorder};
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
      font-size: var(--gren-font-body);

      > span { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color: ${cssVar.colorText}; font-weight: 500; }
      svg { display:inline-block; vertical-align:-2px; margin-inline-end:4px; }
    }
  `,
  itemSummary: css`
    overflow: hidden;
    width: 100%;
    font-size: var(--gren-font-secondary);
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorTextSecondary};
  `,
  paramCount: css`
    flex: none;
    margin-inline-start: auto;
    font-size: var(--gren-font-caption);
    white-space: nowrap;
    color: ${cssVar.colorTextTertiary};
  `,
  rowWrap: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    padding-inline-start: 8px;
    border: 1px solid transparent;
    border-radius: 7px;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
    &[data-active='true'] {
      background: ${cssVar.colorPrimaryBg};
      border-color: ${cssVar.colorPrimaryBorder};
    }

    /* 停用的规则整行变淡，开关本身保持清楚。 */
    &[data-enabled='false'] > button:not([role='switch']) { opacity: 0.55; }

  `,
  rowOpen: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 5px;
    align-items: stretch;
    min-width: 0;
    padding: 8px 9px 8px 0;
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
    font-weight: 500;
    letter-spacing: 0.01em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,
  ruleMeta: css`
    display: flex;
    gap: 3px;
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
    font-size: var(--gren-font-caption);
  `,
  /** 编辑区的模式多选：小胶囊，选中用主色。 */
  modePicker: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  `,
  modeChip: css`
    font-weight: 500;
    letter-spacing: 0.01em;
    padding: 3px 6px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 5px;
    font-size: var(--gren-font-caption);
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
    font-weight: 500;
    letter-spacing: 0.01em;
    flex: none;
    margin-inline-end: auto;
    padding: 0 6px;
    border-radius: 4px;
    font-size: var(--gren-font-caption);
    line-height: 18px;
    color: ${cssVar.colorWarningText};
    background: ${cssVar.colorWarningBg};
  `,
  switchLabel: css`
    font-weight: 500;
    letter-spacing: 0.01em;
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    font-size: var(--gren-font-secondary);
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
  `,
  scopePath: css`
    margin-block-start: 6px;
    font-size: var(--gren-font-caption);
    color: ${cssVar.colorTextTertiary};

  `,  edit: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 16px 18px;
    @container extensions-module (max-height: 560px) { padding: 8px 14px; gap: 8px; }
  `,
  back: css`
    display: none;
    align-items: center;
    align-self: flex-start;
    flex: none;
    gap: 6px;
    padding: 0 0 2px;
    border: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
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
    flex: none;
    gap: 10px;

    h3 {
      min-width: 0;
      margin: 0;
      color: ${cssVar.colorText};
      font-size: var(--gren-font-section);
      font-weight: 600;
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
    font-size: var(--gren-font-secondary);
    color: ${cssVar.colorText};

    span {
      font-size: var(--gren-font-caption);
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
    font-size: var(--gren-font-body);
    color: ${cssVar.colorTextSecondary};
  `,
  params: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: var(--gren-font-caption);
    color: ${cssVar.colorTextTertiary};
  `,
  footer: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding-block-start: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  saveButton: css`
    margin-inline-start: auto;
  `,
  error: css`
    font-size: var(--gren-font-body);
    color: ${cssVar.colorError};
  `,
  empty: css`
    padding: 40px 0;
    font-size: var(--gren-font-body);
    text-align: center;
    color: ${cssVar.colorTextTertiary};
  `,
}));
