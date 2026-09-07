import { createStaticStyles, keyframes } from 'antd-style';
import { INDICATOR_PITCH, MAX_INDICATOR_WIDTH } from './utils';

/** 气泡与 rail 之间留的间距。 */
const POPUP_GAP = 12;

const popupIn = keyframes`
  from {
    transform: translateX(-4px);
    opacity: 0;
  }

  to {
    transform: translateX(0);
    opacity: 1;
  }
`;

export const minimapStyles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    pointer-events: none;

    position: absolute;
    z-index: 1;
    inset-block: 16px;
    inset-inline-start: 8px;

    display: flex;
    flex-direction: column;
    align-items: start;
    justify-content: center;
  `,
  rail: css`
    pointer-events: auto;
    scrollbar-width: none;

    /* 固定为最长刻度的宽度：悬停时刻度伸长不会改变 rail 尺寸，气泡位置也就稳定。 */
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: start;

    width: ${MAX_INDICATOR_WIDTH}px;
    max-height: 50vh;

    /* 对话很长时 rail 自身会溢出，滚轮滚 rail；滚到头也不要把滚动传给底下的消息列表。 */
    overscroll-behavior: contain;
    -ms-overflow-style: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  popup: css`
    pointer-events: none;

    position: absolute;
    top: 0;
    inset-inline-start: ${MAX_INDICATOR_WIDTH + POPUP_GAP}px;

    width: 280px;
    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};

    /* 在相邻刻度间移动时气泡滑过去而不是跳过去；首次出现由组件临时关掉过渡。 */
    transition: top ${cssVar.motionDurationFast} ease;
    animation: ${popupIn} ${cssVar.motionDurationMid} ease;
  `,
}));

export const indicatorStyles = createStaticStyles(({ css, cssVar }) => ({
  /* 命中区撑满 rail 宽度并上下相接：鼠标在 rail 范围内任意位置都落在某条刻度上。 */
  indicator: css`
    cursor: pointer;

    display: flex;
    flex-shrink: 0;
    align-items: center;

    width: 100%;
    height: ${INDICATOR_PITCH}px;
    padding-block: ${(INDICATOR_PITCH - 2) / 2}px;
  `,
  line: css`
    height: 2px;
    border-radius: 1px;
    background: ${cssVar.colorTextQuaternary};

    transition:
      width ${cssVar.motionDurationFast} ease,
      background-color ${cssVar.motionDurationFast} ease;
  `,
  lineActive: css`
    background: ${cssVar.colorPrimary};
  `,
  lineHovered: css`
    background: ${cssVar.colorText};
  `,
}));

export const previewStyles = createStaticStyles(({ css, cssVar }) => ({
  title: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 600;
    line-height: 1.5;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  body: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;

    margin-block-start: 4px;

    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
    word-break: break-word;
  `,
}));
