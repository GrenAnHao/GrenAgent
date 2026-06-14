import { createStyles } from 'antd-style';

export const useCardStyles = createStyles(({ css, cssVar }) => ({
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
  inspectorTitle: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  toolName: css`
    font-family: ${cssVar.fontFamilyCode};
    color: ${cssVar.colorTextSecondary};
  `,
  paramKey: css`
    font-family: ${cssVar.fontFamilyCode};
    color: ${cssVar.colorTextTertiary};
  `,
  paramValue: css`
    font-family: ${cssVar.fontFamilyCode};
    color: ${cssVar.colorTextSecondary};
  `,
  pathLabel: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    word-break: break-all;
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
    padding-inline-start: 4px;
    max-width: 100%;
  `,
  resultsWrap: css`
    position: relative;
  `,
  resultsWrapFade: css`
    &::after {
      content: '';
      position: absolute;
      inset-block: 0 10px;
      inset-inline-end: 0;
      width: 36px;
      pointer-events: none;
      background: linear-gradient(to right, transparent, ${cssVar.colorBgContainer});
    }
  `,
  results: css`
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 6px 4px 10px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  rcard: css`
    flex: none;
    width: 160px;
    height: 80px;
    padding: 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    cursor: pointer;
    text-decoration: none;
    transition: border-color 0.15s;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  rtitle: css`
    font-size: 12px;
    line-height: 1.4;
    color: ${cssVar.colorText};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,
  rfoot: css`
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  `,
  favi: css`
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextTertiary};
    font-size: 9px;
    text-transform: uppercase;
  `,
  rhost: css`
    overflow: hidden;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
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
