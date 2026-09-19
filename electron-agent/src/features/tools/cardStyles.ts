import { createStaticStyles, cssVar } from 'antd-style';

// 零运行时静态样式（仅引用 cssVar 变量），不订阅主题 context：
// 切主题时引用它的工具卡片/思考/子代理等组件不会因此重渲染，只换 CSS 变量值。
export const cardStyles = createStaticStyles(({ css }) => ({
  shinyText: css`
    background: linear-gradient(
      90deg,
      ${cssVar.colorTextDescription} 0%,
      ${cssVar.colorText} 50%,
      ${cssVar.colorTextDescription} 100%
    );
    background-size: 200% auto;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    animation: shinyTextSweep 1.5s linear infinite;

    @keyframes shinyTextSweep {
      to {
        background-position: 200% center;
      }
    }
  `,
  // 极简「思考/准备中」呼吸点：替代笨重的 outlined 方框 + 网格 loading（对齐 ChatGPT / Cursor）。
  breathingDot: css`
    display: inline-block;
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorTextSecondary};
    animation: thinkingDotPulse 1.4s ease-in-out infinite;

    @keyframes thinkingDotPulse {
      0%,
      100% {
        opacity: 0.3;
        transform: scale(0.85);
      }
      50% {
        opacity: 1;
        transform: scale(1);
      }
    }
  `,
  inspectorTitle: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${cssVar.colorTextDescription};
  `,
  toolName: css`
    font-family: ${cssVar.fontFamilyCode};
    color: ${cssVar.colorTextSecondary};
  `,
  // 技能名：与输入框/消息里的技能 chip 同色（紫色），让「调用技能」一眼可辨。
  skillName: css`
    color: ${cssVar.purple};
    font-weight: 500;
  `,
  paramKey: css`
    font-family: ${cssVar.fontFamilyCode};
    color: ${cssVar.colorTextTertiary};
  `,
  paramValue: css`
    font-family: ${cssVar.fontFamilyCode};
    color: ${cssVar.colorTextSecondary};
  `,
  terminalOutput: css`
    overflow: auto;
    max-height: 240px;
    padding: 8px 10px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  `,
  terminalOutputError: css`
    color: ${cssVar.colorError};
  `,
  terminalCard: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  terminalHead: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
  `,
  terminalPrompt: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
    user-select: none;
  `,
  terminalCommandText: css`
    flex: 1;
    min-width: 0;
    color: ${cssVar.colorText};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  terminalCopy: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  terminalBody: css`
    overflow: auto;
    max-height: 320px;
    padding: 8px 10px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  terminalBodyDivided: css`
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  terminalRunning: css`
    color: ${cssVar.colorTextTertiary};
  `,
  thinkingBody: css`
    overflow: auto;
    max-height: min(40vh, 320px);
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  toolRow: css`
    /* 左缘与助手正文(markdown)、深度思考行对齐到 x=0：不再额外左缩进。 */
    min-width: 0;
    max-width: 100%;
  `,
  detailGuide: css`
    /* 折叠详情的层级竖线 + 缩进（与 WorkflowCollapse 的多工具列表线同款），让子级归属一目了然。 */
    margin-inline-start: 11px;
    padding-inline-start: 12px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
    min-width: 0;
    /* 子级排版不超过父级：超宽内容在此裁剪，不把对话流撑宽。 */
    overflow: hidden;
  `,
  divDash: css`
    margin-block-start: 8px;
    border: none;
    border-block-start: 1px dashed ${cssVar.colorBorder};
  `,
  detailScroll: css`
    max-height: min(50vh, 420px);
  `,
  pageCard: css`
    display: flex;
    max-width: 420px;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
  `,
  pageUrl: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  pageUrlText: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  pagePreview: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  pageFooter: css`
    display: flex;
    gap: 12px;
    padding-block-start: 4px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  queryHighlight: css`
    padding: 0 1px;
    color: ${cssVar.colorText};
    /* 荧光笔式底部高亮：底部固定高度色带（不随行高糊成中线/删除线）。 */
    background-image: linear-gradient(
      color-mix(in srgb, ${cssVar.colorInfo} 32%, transparent),
      color-mix(in srgb, ${cssVar.colorInfo} 32%, transparent)
    );
    background-repeat: no-repeat;
    background-position: 0 100%;
    background-size: 100% 0.5em;
  `,
  searchCount: css`
    margin-inline-start: 4px;
    color: ${cssVar.colorTextTertiary};
  `,
}));
