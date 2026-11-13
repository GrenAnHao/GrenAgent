import { createStaticStyles, cssVar } from 'antd-style';

export const codeStyles = createStaticStyles(({ css }) => ({
  root: css`
    container: code-workbench / inline-size;
    display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
    color: ${cssVar.colorText};
    font-size: 13px;
    overflow-wrap: anywhere;
  `,
  /**
   * 工作台卡片吃掉页头以下的剩余高度，结果多少都在栏内滚动，不把整页撑长。
   * 下限 320px：窗口矮到放不下时由外层面板滚动，而不是把列表压成一条缝。
   * 用 && 抬高优先级：元素上同时带 workbenchStyles.panel 的 `min-height: 0`，同优先级的两条规则谁生效取决于样式表的插入顺序，
   * 这里让下限不依赖加载顺序（预防；不加 && 时在 harness 里下限也生效，场景里「矮窗口」那组检查守着它）。
   */
  fill: css`&& { flex: 1; min-height: 320px; overflow: hidden; }`,
  /** 覆盖分栏的 440px 下限，让高度完全由 fill 决定。 */
  split: css`&& { min-height: 0; }`,
  column: css`min-width: 0;`,
  /** 列表栏顶部的计数条：滚动时吸顶，背景盖住下方行。负 margin 抵消分栏的 6px 内边距。 */
  listHeader: css`
    position: sticky; top: -6px; z-index: 1;
    margin: -6px -6px 0; padding: 8px 12px;
    background: ${cssVar.colorBgContainer};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextTertiary}; font-size: 12px;
    font-variant-numeric: tabular-nums;
  `,
  /** 结果列表尾部的「显示更多」：与行同样的圆角语言。 */
  loadMore: css`margin: 2px 6px 6px; padding: 4px 8px; border-radius: 8px;`,
  /** 统计数字聚成一条胶囊：数字等宽、段间细线分隔，不再是一串散落的灰字。 */
  stats: css`
    display: inline-flex; flex-wrap: wrap; align-items: center;
    padding: 3px 6px; border-radius: 999px; background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary}; font-size: 12px; font-variant-numeric: tabular-nums;
    > span { padding: 1px 10px; }
    > span + span { border-inline-start: 1px solid ${cssVar.colorBorderSecondary}; }
    > span:last-child { color: ${cssVar.colorTextTertiary}; }
  `,
  /** 把状态标签与统计聚成一组，和项目选择、操作按钮在页头里清晰分段。 */
  statusCluster: css`display: inline-flex; flex-wrap: wrap; align-items: center; gap: 10px;`,
  /** 详情列：源码卡铺满剩余高度；符号上下文/关系收在底部限高区。 */
  detailColumn: css`
    display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
  `,
  sourceCard: css`
    display: flex; flex-direction: column; gap: 8px;
    flex: 1; min-height: 240px; min-width: 0; padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  sourceToolbar: css`
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0;
    color: ${cssVar.colorTextTertiary}; font-size: 12px;
  `,
  sourceStats: css`font-variant-numeric: tabular-nums;`,
  toolbarSpacer: css`flex: 1;`,
  sourceViewer: css`
    flex: 1; min-height: 0; overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  contextSection: css`
    flex: none; min-height: 0; max-height: 38%; overflow: auto;
    display: flex; flex-direction: column; gap: 8px;
    margin-block-start: 12px;
  `,
  searchIcon: css`display: inline-flex; color: ${cssVar.colorTextTertiary};`,
  detailHeader: css`
    display: flex; align-items: center; gap: 10px; min-width: 0;
    margin-block-end: 12px;
  `,
  detailTitle: css`
    flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;
    h3, h4, h5 { margin: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
  detailPath: css`
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: ${cssVar.colorTextTertiary}; font-size: 12px;
  `,
  relations: css`
    display: flex; flex-direction: column; align-items: stretch; gap: 8px;
    margin-block-start: 16px;
    > .ant-segmented { align-self: flex-start; }
  `,
  raw: css`
    max-width: 100%; min-width: 0; margin: 6px; color: ${cssVar.colorTextSecondary};
    summary { cursor: pointer; font-size: 12px; color: ${cssVar.colorTextTertiary}; }
    pre { max-width: 100%; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  `,
  text: css`font: inherit; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;`,
}));
