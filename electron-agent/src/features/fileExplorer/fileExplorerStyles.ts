import { createStaticStyles, cssVar } from 'antd-style';

export const fileExplorerStyles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    height: 100%;
    min-height: 0;
    min-width: 0;
    background: ${cssVar.colorBgContainer};
  `,
  treePane: css`
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: 0;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  treeHeader: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 4px 0 12px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  treeToggle: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: ${cssVar.colorTextSecondary};
    background: transparent;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  treeRail: css`
    display: flex;
    flex: none;
    align-items: flex-start;
    justify-content: center;
    width: 32px;
    padding-top: 4px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  treeSearch: css`
    flex: none;
    padding: 8px 8px 6px;
  `,
  treeBody: css`
    flex: 1;
    min-height: 0;
    overflow: hidden;
  `,
  treeScroll: css`
    height: 100%;
    overflow: auto;
    font-size: 13px;
  `,
  treeRow: css`
    display: flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    height: 28px;
    padding-right: 8px;
    color: ${cssVar.colorText};
    white-space: nowrap;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    /* 右键菜单开着时标出是哪一行（选中跟着打开的文件走，右键不改选中）。 */
    &[data-menu-open='true'] {
      box-shadow: inset 0 0 0 1px ${cssVar.colorPrimaryBorder};
    }
  `,
  treeRowSelected: css`
    background: ${cssVar.controlItemBgActive};

    &:hover {
      background: ${cssVar.controlItemBgActive};
    }
  `,
  treeChevron: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 16px;
    color: ${cssVar.colorTextTertiary};

    svg {
      transition: transform 0.15s ease;
    }

    &[data-expanded='true'] svg {
      transform: rotate(90deg);
    }
  `,
  treeTitle: css`
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
  `,
  treeHint: css`
    padding: 4px 12px;
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
  `,
  match: css`
    color: ${cssVar.colorPrimary};
    font-weight: 600;
  `,
  truncatedNode: css`
    color: ${cssVar.colorTextDescription};
    font-style: italic;
  `,
  pathBar: css`
    display: flex;
    flex: none;
    gap: 4px;
    align-items: center;
    min-height: 30px;
    padding: 2px 4px 2px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
  `,
  /* 省略号只吃目录部分，文件名不被截。 */
  pathText: css`
    display: flex;
    flex: 1;
    min-width: 0;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;

    &[data-hover='true'] {
      color: ${cssVar.colorText};
    }
  `,
  pathDir: css`
    overflow: hidden;
    flex: 0 1 auto;
    min-width: 0;
    text-overflow: ellipsis;
  `,
  pathName: css`
    overflow: hidden;
    flex: 0 0 auto;
    max-width: 100%;
    text-overflow: ellipsis;
  `,
  pathEmpty: css`
    overflow: hidden;
    color: ${cssVar.colorTextDescription};
    text-overflow: ellipsis;
  `,
  pathTip: css`
    white-space: pre-wrap;
    word-break: break-all;
  `,
  pathButton: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border: 0;
    border-radius: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    background: transparent;
    cursor: pointer;

    &:hover:not(:disabled) {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      color: ${cssVar.colorTextQuaternary};
      cursor: default;
    }
  `,
  splitter: css`
    position: relative;
    flex: none;
    width: 5px;
    margin-inline-end: -3px;
    cursor: col-resize;
    touch-action: none;
    z-index: 1;

    &:hover,
    &[data-dragging='true'] {
      background: ${cssVar.colorPrimaryBorder};
    }
  `,
  /* 内容列：上面文件标签栏，下面当前标签的查看器（其余标签 display: none 挂着）。 */
  viewerColumn: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  `,
  tabPane: css`
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  `,
  tabBar: css`
    display: flex;
    flex: none;
    overflow-x: auto;
    overflow-y: hidden;
    height: 34px;
    background: ${cssVar.colorFillQuaternary};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    /* 不显示滚动条（Windows 上它会占掉标签的高度）：纵向滚轮横着滚，当前标签自动滚进可视区。 */
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  tab: css`
    position: relative;
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    max-width: 240px;
    padding: 0 6px 0 12px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    outline: none;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &[data-active='true'] {
      color: ${cssVar.colorText};
      background: ${cssVar.colorBgContainer};
    }

    /* 当前标签顶上一条主色，底边盖掉标签栏的分隔线，和下面的工具栏连成一片。 */
    &[data-active='true']::before {
      position: absolute;
      inset: 0 0 auto;
      height: 2px;
      background: ${cssVar.colorPrimary};
      content: '';
    }

    &[data-active='true']::after {
      position: absolute;
      inset: auto 0 -1px;
      height: 1px;
      background: ${cssVar.colorBgContainer};
      content: '';
    }

    &:focus-visible {
      box-shadow: inset 0 0 0 1px ${cssVar.colorPrimaryBorder};
    }
  `,
  tabName: css`
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
  `,
  tabHint: css`
    overflow: hidden;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 120px;
    color: ${cssVar.colorTextDescription};
    text-overflow: ellipsis;
  `,
  /* 关闭按钮：当前标签和悬停时显示 ×；未保存的标签平时显示圆点，悬停在按钮上换成 ×。 */
  tabClose: css`
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    color: ${cssVar.colorTextSecondary};
    background: transparent;
    cursor: pointer;
    visibility: hidden;

    [data-file-tab]:hover > &,
    [data-file-tab][data-active='true'] > &,
    [data-file-tab][data-dirty='true'] > & {
      visibility: visible;
    }

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    [data-file-tab][data-dirty='true'] > & > svg {
      display: none;
    }

    [data-file-tab][data-dirty='true'] > &:hover > span {
      display: none;
    }

    [data-file-tab][data-dirty='true'] > &:hover > svg {
      display: block;
    }
  `,
  tabCloseIcon: css`
    display: block;
  `,
  tabDirtyDot: css`
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${cssVar.colorWarning};
  `,
  viewer: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    outline: none;
  `,
  /* 窄面板里一行放不下时按钮组折到下一行，而不是把面包屑挤没。 */
  toolbar: css`
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    min-height: 36px;
    padding: 4px 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  navButtons: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  `,
  spin: css`
    animation: file-nav-spin 0.8s linear infinite;

    @keyframes file-nav-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  /* 面包屑只占自己需要的宽度（不再 flex: 1 铺满），每级有上限、超长省略，完整路径在悬停提示和路径栏里。 */
  crumbs: css`
    overflow: hidden;
    flex: 0 1 auto;
    min-width: 0;
    font-size: 12px;
    white-space: nowrap;

    ol {
      flex-wrap: nowrap;
    }

    li {
      overflow: hidden;
      min-width: 0;
      max-width: 120px;
      text-overflow: ellipsis;
    }

    li:last-child {
      max-width: 200px;
    }
  `,
  meta: css`
    flex: none;
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
    white-space: nowrap;
  `,
  dirtyDot: css`
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${cssVar.colorWarning};
  `,
  actions: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    margin-inline-start: auto;
  `,
  banner: css`
    flex: none;
    border-radius: 0;
    border-inline: 0;
    border-block-start: 0;
  `,
  body: css`
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  `,
  pane: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
  `,
  splitPreview: css`
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  markdown: css`
    overflow: auto;
    height: 100%;
    padding: 16px 20px 32px;
    outline: none;
  `,
  center: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 24px;
    color: ${cssVar.colorTextDescription};
    font-size: 13px;
    text-align: center;
  `,
  image: css`
    overflow: auto;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 16px;
    background-color: ${cssVar.colorFillQuaternary};
    background-image:
      linear-gradient(45deg, ${cssVar.colorFillTertiary} 25%, transparent 25%),
      linear-gradient(-45deg, ${cssVar.colorFillTertiary} 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, ${cssVar.colorFillTertiary} 75%),
      linear-gradient(-45deg, transparent 75%, ${cssVar.colorFillTertiary} 75%);
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    background-size: 16px 16px;

    img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
  `,
}));
