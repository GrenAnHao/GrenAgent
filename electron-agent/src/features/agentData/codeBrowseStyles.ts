import { createStaticStyles, cssVar as v } from 'antd-style';

export const browseStyles = createStaticStyles(({ css }) => ({
  home: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable both-edges;
    padding: clamp(16px, 3cqw, 32px) clamp(0px, 2cqw, 24px) 24px;
  `,
  homeInner: css`
    width: min(100%, 1152px);
    margin-inline: auto;
  `,
  homeHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 18px;
    h3 { margin: 0; font-size: var(--gren-font-heading); font-weight: 600; letter-spacing: -0.02em; line-height: 1.3; }
  `,
  homeActions: css`display: flex; align-items: center; gap: 8px; flex-wrap: wrap;`,
  lobbyBar: css`
    display: flex; align-items: center; gap: 16px; min-height: 42px; flex: none;
    h2 { margin: 0; font-size: var(--gren-font-heading); font-weight: 600; letter-spacing: -0.02em; line-height: 1.3; }
  `,
  lobbyStats: css`
    display: flex; align-items: baseline; gap: 6px; border-left: 1px solid ${v.colorBorderSecondary};
    padding-left: 16px; color: ${v.colorTextSecondary}; font-size: var(--gren-font-secondary); font-variant-numeric: tabular-nums;
    [data-stale] { color: ${v.colorWarningText}; }
  `,
  projectHeading: css`
    display: inline-flex; gap: 6px; align-items: center; white-space: nowrap;
    @container code-workbench (max-width: 600px) { h2 { display: none; } }
  `,
  filters: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 9px 14px; margin-bottom: 18px;
  `,
  filterSearch: css`
    && { flex: 0 1 280px; min-width: min(100%, 180px); }
    @container code-workbench (max-width: 680px) { && { flex: 1 0 100%; } }
  `,
  filterPills: css`
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    button {
      font: inherit; cursor: pointer; border: 0; border-radius: 999px;
      padding: 4px 10px; font-size: var(--gren-font-secondary); font-weight: 500; letter-spacing: 0.01em; color: ${v.colorTextSecondary}; background: transparent;
    }
    button:hover { color: ${v.colorText}; background: ${v.colorFillTertiary}; }
    button[aria-pressed='true'] { background: ${v.colorPrimaryBg}; color: ${v.colorPrimaryText}; }
  `,
  syncAll: css`&& { margin-inline-start: auto; font-size: var(--gren-font-body); }`,
  noMatch: css`
    padding: 54px 16px; display: grid; justify-items: center; gap: 8px;
    border-block: 1px solid ${v.colorBorderSecondary}; color: ${v.colorTextSecondary};
  `,
  cards: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px;
    @container code-workbench (max-width: 930px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container code-workbench (max-width: 590px) { grid-template-columns: minmax(0, 1fr); }
  `,
  card: css`
    position: relative; min-width: 0; border-radius: 12px;
    background: ${v.colorBgContainer}; border: 1px solid ${v.colorBorderSecondary};
    transition: border-color .15s;
    &:hover, &:focus-within { border-color: ${v.colorPrimary}; }
    &:hover [data-card-arrow], &:focus-within [data-card-arrow] { transform: translateX(3px); }
    &[data-first-build] [data-card-arrow], &:is(:hover,:focus-within)[data-quick] [data-card-arrow] { opacity: 0; }
    &[data-first-build] [data-card-status], &:is(:hover,:focus-within)[data-quick] [data-card-status] { margin-inline-end: 50px; }
    &[data-first-build] [data-card-quick], &:is(:hover,:focus-within) [data-card-quick] { opacity: 1; pointer-events: auto; }
    @media (hover: none) {
      [data-card-quick] { opacity: 1; pointer-events: auto; }
      &[data-quick] [data-card-arrow] { opacity: 0; }
      &[data-quick] [data-card-status] { margin-inline-end: 50px; }
    }
    @media (prefers-reduced-motion: reduce) { &, [data-card-arrow], [data-card-quick] { transition: none; } }
  `,
  cardMain: css`
    display: grid; grid-template-columns: minmax(0,1fr); width: 100%;
    grid-template-rows: 34px 24px 21px 42px 32px;
    align-items: center; text-align: start; min-width: 0; padding: 16px 17px 10px;
    font: inherit; color: inherit; background: transparent; border: 0; border-radius: inherit; cursor: pointer;
    > strong { letter-spacing: -0.015em; align-self: end; font-size: var(--gren-font-section); line-height: 21px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    &:focus-visible { outline: 2px solid ${v.colorPrimary}; outline-offset: 2px; }
  `,
  cardHead: css`
    display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-inline-end: 27px;
  `,
  cardMenu: css`
    position: absolute; top: 19px; right: 12px;
    button { width: 25px; height: 26px; border: none; box-shadow: none; background: transparent; color: ${v.colorTextTertiary}; }
  `,
  quick: css`
    position: absolute; right: 12px; bottom: 11px; height: 25px; display: inline-flex; align-items: center; gap: 4px;
    opacity: 0; pointer-events: none; transition: opacity .12s; padding: 0 8px; font: inherit; font-size: var(--gren-font-secondary);
    border: 0; border-radius: 6px; color: ${v.colorPrimaryText}; background: ${v.colorPrimaryBg}; cursor: pointer;
    &:hover { color: ${v.colorPrimaryTextActive}; }
  `,
  spin: css`
    animation: index-project-spin .9s linear infinite;
    @keyframes index-project-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { animation: none; }
  `,
  folderIcon: css`
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    color: ${v.colorPrimary};
    background: ${v.colorPrimaryBg};
  `,
  badge: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    width: max-content;
    padding: 2px 9px;
    line-height: 18px;
    border-radius: 999px;
    font-size: var(--gren-font-secondary);
    font-weight: 500;
    letter-spacing: 0.01em;
    white-space: nowrap;
    background: ${v.colorFillTertiary};
    color: ${v.colorTextSecondary};
    &::before {
      content: '';
      width: 5px;
      height: 5px;
      background: currentColor;
      border-radius: 50%;
    }
    &[data-tone='success'] {
      color: ${v.colorSuccessText};
      background: ${v.colorSuccessBg};
    }
    &[data-tone='processing'] {
      color: ${v.colorInfoText};
      background: ${v.colorInfoBg};
    }
    &[data-tone='warning'] {
      color: ${v.colorWarningText};
      background: ${v.colorWarningBg};
    }
    &[data-tone='error'] {
      color: ${v.colorErrorText};
      background: ${v.colorErrorBg};
    }
  `,
  cardPath: css`
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: var(--gren-font-secondary); line-height: 18px; color: ${v.colorTextSecondary};
  `,
  cardMetrics: css`
    display: flex; align-items: center; gap: clamp(6px, 1cqw, 14px); min-width: 0;
    white-space: nowrap; overflow: hidden; color: ${v.colorTextSecondary}; font-size: var(--gren-font-secondary);
    b { font-weight: 550; font-variant-numeric: tabular-nums; color: ${v.colorText}; }
  `,
  cardFoot: css`
    display: flex; align-items: center; align-self: stretch; gap: 6px; min-width: 0;
    border-top: 1px solid ${v.colorBorderSecondary}; padding-top: 5px; font-size: var(--gren-font-secondary); color: ${v.colorTextSecondary};
    svg { flex: none; }
    [data-card-status] { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    [data-card-arrow] { margin-left: auto; color: ${v.colorTextTertiary}; transition: transform .15s, opacity .12s; }
  `,
  dropArea: css`
    font: inherit;
    width: 100%;
    padding: 42px;
    display: grid;
    gap: 12px;
    justify-items: center;
    border: 1px dashed ${v.colorBorder};
    border-radius: 12px;
    background: ${v.colorFillQuaternary};
    color: ${v.colorTextSecondary};
    cursor: pointer;
  `,
  toolbar: css`
    display: grid;
    grid-template-columns: auto minmax(140px, 300px) minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    flex: none;
    min-height: 42px;
    margin-bottom: 14px;
    h2 {
      margin: 0;
      font-size: var(--gren-font-heading);
      font-weight: 600;
      letter-spacing: -0.02em;
      line-height: 1.3;
      white-space: nowrap;
    }
    @container code-workbench (max-width: 980px) {
      grid-template-columns: auto minmax(0, 1fr) auto;
      row-gap: 4px;
      [data-index-stats] {
        grid-row: 2;
        grid-column: 1/-1;
      }
      [data-index-controls] {
        grid-column: 3;
        grid-row: 1;
      }
    }
    @container code-workbench (max-width: 525px) {
      gap: 6px;
    }
  `,
  statsSlot: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 32px;
    overflow: hidden;
    [data-stat-strip] {
      min-width: 0;
      overflow: auto hidden;
      white-space: nowrap;
      scrollbar-width: none;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 3px 10px;
      border-radius: 999px;
      background: ${v.colorFillTertiary};
      color: ${v.colorTextSecondary};
      font-size: var(--gren-font-secondary);
      font-variant-numeric: tabular-nums;
    }
  `,
  controls: css`
    display: flex;
    align-items: center;
    gap: 6px;
  `,
  browseHead: css`
    position: sticky;
    top: -6px;
    z-index: 2;
    margin: -6px -6px 4px;
    padding: 7px 9px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 5px;
    background: var(--gren-master-bg, ${v.colorBgContainer});
    border-bottom: 1px solid var(--gren-master-divider, ${v.colorBorderSecondary});
    [data-count] {
      color: ${v.colorTextSecondary};
      font-size: var(--gren-font-secondary);
    }
  `,
  viewButtons: css`
    display: inline-flex;
    align-items: center;
    gap: 1px;
    > button {
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 5px;
      background: none;
      color: ${v.colorTextSecondary};
      height: 26px;
      min-width: 26px;
      cursor: pointer;
    }
    > button:hover {
      background: ${v.colorFillTertiary};
    }
    > button[aria-checked='true'] {
      color: ${v.colorPrimaryText};
      background: ${v.colorPrimaryBg};
    }
  `,
  branch: css`
    padding-left: 11px;
    margin-left: 9px;
    border-left: 1px solid ${v.colorBorderSecondary};
  `,
  folder: css`
    font: inherit;
    color: ${v.colorText};
    background: none;
    border: none;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-width: 0;
    padding: 8px;
    cursor: pointer;
    &:hover,
    &[data-key-active='true'] {
      background: ${v.colorFillTertiary};
    }
    > svg {
      flex: none;
      color: ${v.colorTextSecondary};
    }
    > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    > small {
      margin-left: auto;
      color: ${v.colorTextTertiary};
    }
  `,
  actionRow: css`
    position: relative;
    width: 100%;
    min-width: 0;
    [data-file-actions] {
      position: absolute;
      right: 4px;
      top: 4px;
      visibility: hidden;
      background: ${v.colorBgContainer};
      border-radius: 5px;
    }
    &:hover [data-file-actions],
    &:focus-within [data-file-actions] {
      visibility: visible;
    }
  `,
  fileActions: css`
    display: inline-flex;
    gap: 2px;
    flex: none;
    button {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: 5px;
      color: ${v.colorTextSecondary};
      cursor: pointer;
      background: none;
    }
    button:hover,
    button:focus-visible {
      color: ${v.colorPrimaryText};
      background: ${v.colorPrimaryBg};
    }
  `,
  overview: css`
    max-width: 850px;
    margin: 2px auto;
    color: ${v.colorText};
    h3 {
      margin: 0;
      font-size: var(--gren-font-section);
      letter-spacing: -0.015em;
    }
    h4 {
      font-size: var(--gren-font-body);
      margin: 0;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    small {
      color: ${v.colorTextSecondary};
      font-size: var(--gren-font-secondary);
    }
  `,
  lang: css`
    padding: 18px 0 20px;
    margin: 16px 0 18px;
    border-block: 1px solid ${v.colorBorderSecondary};
  `,
  band: css`
    display: flex;
    height: 7px;
    border-radius: 4px;
    overflow: hidden;
    margin: 12px 0;
    gap: 2px;
  `,
  legend: css`
    display: flex;
    flex-wrap: wrap;
    gap: 5px 16px;
    font-size: var(--gren-font-secondary);
    color: ${v.colorTextSecondary};
    i {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 2px;
      margin-right: 5px;
    }
  `,
  rank: css`
    font: inherit;
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    width: 100%;
    border: 0;
    border-radius: 6px;
    padding: 7px 6px;
    text-align: left;
    background: none;
    color: inherit;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    > small:first-child {
      color: ${v.colorTextTertiary};
    }
    span,
    b {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    b {
      font-weight: 500;
    }
    span small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    &:hover {
      background: ${v.colorFillTertiary};
    }
  `,
  mobileOverview: css`
    display: none;
    @container code-workbench (max-width: 799px) {
      display: inline-flex;
    }
  `,
}));
