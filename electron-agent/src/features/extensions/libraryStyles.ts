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
  hero: css`
    display: flex;
    gap: 10px;
    align-items: center;
  `,
  heroIcon: css`
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    color: ${cssVar.colorText};
    background: ${cssVar.colorFillTertiary};
  `,
  heroTitle: css`
    display: inline-flex;
    align-items: center;
    font-size: 20px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  count: css`
    margin-inline-start: 8px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillSecondary};
  `,
  desc: css`
    margin-block: 0 20px;
    font-size: 14px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
  `,
  split: css`
    display: flex;
    flex: 1;
    min-height: 420px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  list: css`
    display: flex;
    flex: 0 0 300px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    overflow-y: auto;
    padding: 10px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  item: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
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
  rowWrap: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding-inline-start: 12px;
    border-radius: 7px;

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
    padding: 10px 12px 10px 0;
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
    padding: 10px 4px 0;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  badge: css`
    flex: none;
    white-space: nowrap;
    margin-inline-start: auto;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    background: ${cssVar.colorFillTertiary};
  `,
  edit: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    overflow-y: auto;
    padding: 20px 24px;
  `,
  fillField: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
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
