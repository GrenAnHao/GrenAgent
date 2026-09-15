import { createStaticStyles, cssVar } from 'antd-style';

/**
 * 对话内容列宽度：按容器百分比伸缩，不用 vw。
 *   - 86%：主体比例，两侧留白接近 Codex；
 *   - 下限 760px：容器 ≤883px 时 86% 失效，走固定下限（窄于旧 61.8%/620：≤760px 由 100% 铺满）；
 *   - 上限 1120px：再宽只增加留白；
 *   - min 的 100%：比 760px 更窄时铺满。
 * 消息列与输入区共用同一表达式。
 */
export const CHAT_CONTENT_WIDTH = 'min(100%, 1120px, max(760px, 86%))';

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
    font: var(--pi-md-base);
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
