import { createStaticStyles, cssVar } from 'antd-style';

/** 共享的 ChatItem 外壳 / 气泡 / ContentBlock 样式（对齐 lobehub 间距，无头像）。 */
export const chatStyles = createStaticStyles(({ css }) => ({
  item: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-block: 8px;
    max-width: 100%;
    /* 视口外的消息交给浏览器跳过 layout/paint：大幅降低长对话「首次渲染」「切主题整片重排」开销。
       contain-intrinsic-size 为屏外项提供占位高度（auto 让浏览器记住上次实测值），减少滚动跳动。 */
    content-visibility: auto;
    contain-intrinsic-size: auto 64px;

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
