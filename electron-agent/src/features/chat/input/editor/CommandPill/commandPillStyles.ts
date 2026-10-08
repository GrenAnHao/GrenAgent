import { createStaticStyles, cssVar, keyframes } from 'antd-style';

const shake = keyframes`
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  75% { transform: translateX(3px); }
`;

/** 命令胶囊：外层 7px 圆角矩形铺满命令底色，只有参数是 4px 圆角矩形。输入框和气泡共用。 */
export const pillStyles = createStaticStyles(({ css }) => ({
  pill: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
    vertical-align: -4px;

    padding: 3px 3px 3px 9px;
    border-radius: 7px;

    line-height: 1.6;
    white-space: nowrap;

    background: color-mix(in srgb, ${cssVar.purple} 22%, transparent);

    &[data-noarg='true'] {
      padding-inline-end: 9px;
    }
  `,
  command: css`
    display: inline-flex;
    gap: 3px;
    align-items: center;
    margin-inline-end: 2px;

    font-weight: 600;
    color: ${cssVar.purple};
  `,
  arg: css`
    display: inline-flex;
    gap: 5px;
    align-items: center;

    padding: 0 7px;
    border-radius: 4px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgLayout} 55%, transparent);
  `,
  argFocus: css`
    box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
    background: color-mix(in srgb, ${cssVar.colorPrimary} 14%, transparent);
  `,
  argInvalid: css`
    box-shadow: 0 0 0 1px ${cssVar.colorError};
    animation: ${shake} 0.3s ease-in-out 2;
  `,
  key: css`
    font-size: 11px;
    color: color-mix(in srgb, ${cssVar.purple} 75%, ${cssVar.colorTextSecondary});
  `,
  input: css`
    field-sizing: content;
    min-width: 2ch;
    max-width: 320px;
    padding: 0;
    border: 0;
    outline: none;

    font: inherit;
    color: inherit;

    background: transparent;

    &::placeholder {
      font-style: italic;
      color: ${cssVar.colorTextQuaternary};
    }
  `,
}));
