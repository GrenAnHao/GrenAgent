import { createStaticStyles, cssVar } from 'antd-style';

export const codeStyles = createStaticStyles(({ css }) => ({
  root: css`
    container: code-workbench / inline-size;
    min-width: 0;
    color: ${cssVar.colorText};
    font-size: 13px;
    overflow-wrap: anywhere;
  `,
  column: css`min-width: 0;`,
  stats: css`display: flex; flex-wrap: wrap; gap: 12px; color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  heading: css`
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: 12px;
    h3, h4 { margin: 0; font-size: 15px; font-weight: 600; }
  `,
  toolbar: css`display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-block: 12px; min-width: 0;`,
  input: css`
    min-width: 0; max-width: 100%; box-sizing: border-box; flex: 1;
    height: 34px; padding-inline: 10px; border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px; background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText};
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; }
  `,
  select: css`
    width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box;
    height: 34px; padding-inline: 8px; border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px; background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText};
  `,
  button: css`
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    min-height: 34px; padding: 5px 10px; border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px; background: ${cssVar.colorBgContainer}; color: ${cssVar.colorTextSecondary};
    font: inherit; cursor: pointer;
    &:hover:not(:disabled) { border-color: ${cssVar.colorPrimary}; color: ${cssVar.colorPrimary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; }
    &:disabled { opacity: .5; cursor: not-allowed; }
    &[aria-pressed='true'], &[aria-selected='true'] { color: ${cssVar.colorPrimary}; border-color: ${cssVar.colorPrimary}; background: ${cssVar.colorPrimaryBg}; }
  `,
  card: css`
    min-width: 0; padding: 14px; margin-bottom: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 7px;
    background: ${cssVar.colorBgContainer};
  `,
  hint: css`color: ${cssVar.colorTextTertiary}; line-height: 1.6; overflow-wrap: anywhere;`,
  error: css`padding: 8px 10px; margin-block: 8px; border-radius: 5px; color: ${cssVar.colorError}; background: ${cssVar.colorErrorBg}; overflow-wrap: anywhere;`,
  state: css`padding: 24px 12px; color: ${cssVar.colorTextTertiary}; line-height: 1.7; text-align: center; border: 1px dashed ${cssVar.colorBorderSecondary}; border-radius: 7px;`,
  results: css`display: grid; gap: 7px; list-style: none; padding: 0; margin: 10px 0; min-width: 0;`,
  result: css`
    display: block; width: 100%; min-width: 0; box-sizing: border-box; text-align: start;
    padding: 10px 12px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px;
    color: ${cssVar.colorText}; background: ${cssVar.colorBgContainer}; font: inherit; overflow-wrap: anywhere;
    &[type='button'] { cursor: pointer; }
    &[type='button']:hover { border-color: ${cssVar.colorPrimary}; }
    &[aria-pressed='true'] { border-color: ${cssVar.colorPrimary}; background: ${cssVar.colorPrimaryBg}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; }
    strong, span { display: block; }
  `,
  raw: css`
    max-width: 100%; min-width: 0; margin-block: 10px; color: ${cssVar.colorTextSecondary};
    summary { cursor: pointer; }
    pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  `,
  text: css`font: inherit; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;`,
  source: css`
    max-height: 520px; max-width: 100%; overflow: auto; margin: 10px 0;
    padding-block: 8px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px;
    background: ${cssVar.colorFillQuaternary}; font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
    > div { display: flex; align-items: baseline; padding-inline: 8px; min-height: 1.7em; }
    > div[aria-current='location'] { background: ${cssVar.colorPrimaryBg}; box-shadow: inset 2px 0 ${cssVar.colorPrimary}; }
    [data-line-number] { flex: 0 0 4em; padding-right: 12px; text-align: right; color: ${cssVar.colorTextTertiary}; user-select: none; }
    code { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: inherit; }
  `,
}));
