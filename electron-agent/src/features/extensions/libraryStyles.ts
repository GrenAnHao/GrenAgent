import { createStaticStyles, cssVar } from 'antd-style';

/** 命令页签和规则页签共用：左列表、右编辑。 */
export const libraryStyles = createStaticStyles(({ css }) => ({
  heroBar: css`
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 8px;
  `,
  heroTitle: css`
    font-size: 17px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  desc: css`
    margin-block: 0 14px;
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
  `,
  split: css`
    display: flex;
    min-height: 420px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  list: css`
    display: flex;
    flex: 0 0 42%;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  item: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
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
  rowWrap: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding-inline-start: 8px;
    border-radius: 6px;

    &[data-active='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  rowOpen: css`
    display: flex;
    flex: 1;
    gap: 8px;
    align-items: center;
    min-width: 0;
    padding: 6px 8px 6px 0;
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
    margin-inline-end: 8px;
  `,
  listNote: css`
    margin-block-start: auto;
    padding: 8px 4px 0;
    font-size: 11px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  badge: css`
    flex: none;
    white-space: nowrap;
    margin-inline-start: auto;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    background: ${cssVar.colorFillTertiary};
  `,
  edit: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding: 14px 16px;
  `,
  label: css`
    margin-block-end: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  empty: css`
    padding: 32px 0;
    font-size: 12px;
    text-align: center;
    color: ${cssVar.colorTextTertiary};
  `,
}));
