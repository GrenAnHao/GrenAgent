import { createStaticStyles, cssVar } from 'antd-style';

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
