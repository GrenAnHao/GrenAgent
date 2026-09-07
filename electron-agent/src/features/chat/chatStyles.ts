import { createStaticStyles, cssVar } from 'antd-style';

/**
 * 对话内容列的「黄金宽度」：会话区是可调面板，宽度 ≠ 视口宽度，所以按容器百分比伸缩而不用 vw；
 * 纯 CSS 表达即可跟随容器，不必再上 ResizeObserver。三段取值的意图：
 *   - 61.8%（1/φ）：主体比例，会话区变宽时正文同步变宽，两侧留白始终占黄金分割的另一半；
 *   - 下限 620px：会话区约 1000px 以内时 61.8% 会把正文压得比这更窄，改走固定下限，
 *     免得中等宽度下留白比正文还抢眼；
 *   - 上限 960px：再宽行长就超出舒适阅读区间，超宽屏只增加留白而不继续拉长文本行；
 *   - min 里的 100%：会话区比下限还窄时（子代理面板、极窄窗口）退回铺满，不倒过来挤压正文。
 * 消息列与输入区共用同一表达式，两者左右边缘才能对齐成同一条内容列。
 */
export const CHAT_CONTENT_WIDTH = 'min(100%, 960px, max(620px, 61.8%))';

/** 共享的 ChatItem 外壳 / 气泡 / ContentBlock 样式（对齐 lobehub 间距，无头像）。 */
export const chatStyles = createStaticStyles(({ css }) => ({
  item: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-block: 8px;
    max-width: 100%;
    /* 这里不要再加 content-visibility:auto / contain-intrinsic-size：外层已是 virtua 虚拟列表
       （离屏条目直接卸载，无需浏览器再做屏外跳过）。两者叠加会让 contain-intrinsic-size 的占位/
       记忆高度与 virtua 实测高度打架——含多个工具的长 turn 折叠或重排后，条目底部会残留一大片空白
       （表现为 turn 与其后 spawn_agent 卡片之间的大间隙）。 */

    &:hover .chat-actions,
    &:focus-within .chat-actions {
      opacity: 1;
    }
  `,
  itemUser: css`
    align-items: flex-end;
    padding-inline-start: 36px;
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 100%;
    overflow: hidden;
  `,
  bodyAssistant: css`
    width: 100%;
  `,
  bubble: css`
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 28px;
    opacity: 0;
    transition: opacity 0.2s ease;
  `,
  actionsRight: css`
    align-self: flex-end;
  `,
  actionsLeft: css`
    align-self: flex-start;
  `,
}));
