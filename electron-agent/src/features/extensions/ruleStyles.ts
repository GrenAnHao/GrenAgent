import { createStaticStyles, cssVar } from 'antd-style';

export const ruleStyles = createStaticStyles(({ css }) => ({
  split: css`
    @container extension-content (min-width: 681px) {
      && { grid-template-columns: clamp(238px, 29%, 320px) minmax(0, 1fr); }
    }
  `,
  numeric: css`font-variant-numeric: tabular-nums;`,
  controls: css`
    flex: none; display: grid; gap: 8px; margin: 0 4px 4px; font-variant-numeric: tabular-nums;
    .ant-input-prefix { color: ${cssVar.colorTextTertiary}; }
  `,
  group: css`
    margin: 16px 10px 4px; color: ${cssVar.colorTextSecondary}; font-size: var(--gren-font-secondary); font-weight: 500;
  `,
  leading: css`display: inline-flex; flex: 0 0 32px; min-width: 32px; align-items: center; justify-content: center; color: ${cssVar.colorTextTertiary};`,
  rowTitle: css`
    display: flex; align-items: baseline; min-width:0; gap: 6px; font-size: var(--gren-font-body); font-weight: 500;
    > span:first-child { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  `,
  filename: css`
    color: ${cssVar.colorTextSecondary}; font: var(--gren-font-caption)/1.6 var(--font-mono);
    min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:2px 6px; border-radius:4px; border:1px solid ${cssVar.colorBorderSecondary};
  `,
  directory: css`
    display: block; direction: rtl; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: ${cssVar.colorTextSecondary}; font: var(--gren-font-caption)/1.5 var(--font-mono);
  `,
  head: css`flex: none; display: grid; gap: 8px; border-bottom: 1px solid ${cssVar.colorBorderSecondary}; padding-bottom: 14px;`,
  headline: css`
    display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
    h3 { margin:0; font-weight:600; font-size:var(--gren-font-section); overflow-wrap:anywhere; }
  `,
  identity: css`display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 6px 10px; align-items: center; min-width: 0;`,
  badge: css`
    display: inline-flex; align-items:center; border-radius:5px; padding:2px 6px; font-size:var(--gren-font-caption);
    background: ${cssVar.colorFillTertiary}; color: ${cssVar.colorTextSecondary};
  `,
  budget: css`font: var(--gren-font-caption)/1.7 var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap;`,
  actions: css`
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-inline-start: auto;
    button:not([role=switch]) { height: 28px; }
  `,
  metadata: css`display: flex; align-items: center; flex-wrap: wrap; gap: 5px;`,
  path: css`
    display: inline-flex; align-items: baseline; gap: 6px; justify-self: start; max-width: 100%; padding: 0;
    background: transparent; border: none; color: ${cssVar.colorTextSecondary}; cursor: pointer; text-align: start;
    code { overflow-wrap: anywhere; font: var(--gren-font-secondary)/1.5 var(--font-mono); } svg { flex: none; }
    &:hover { color: ${cssVar.colorText}; }
  `,
  document: css`flex: 1; min-height: 0; overscroll-behavior: contain; overflow: auto; overflow-wrap: anywhere;`,
  source: css`&& { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; resize: none; font: var(--gren-font-body)/1.65 var(--font-mono); tab-size: 4; }`,
}));
