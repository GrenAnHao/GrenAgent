import { memo } from 'react';
import { cx } from 'antd-style';
import { indicatorStyles } from './styles';
import type { MinimapIndicatorProps } from './types';
import { getIndicatorWidth, MAX_EMPHASIS } from './utils';

/** 单条刻度横线：默认统一长度，悬停时按突出程度伸长，点击跳到对应消息。 */
export const MinimapIndicator = memo<MinimapIndicatorProps>(
  ({ id, listIndex, position, emphasis, isActive, onJump, onHover }) => {
    const isHovered = emphasis === MAX_EMPHASIS;

    return (
      <div
        aria-current={isActive ? 'true' : undefined}
        aria-label={`跳转到第 ${position + 1} 条消息`}
        className={indicatorStyles.indicator}
        id={id}
        role="button"
        onClick={() => onJump(listIndex)}
        onMouseEnter={(event) => onHover(position, event.currentTarget)}
      >
        <div
          className={cx(
            indicatorStyles.line,
            isHovered ? indicatorStyles.lineHovered : isActive && indicatorStyles.lineActive,
          )}
          style={{ width: getIndicatorWidth(emphasis) }}
        />
      </div>
    );
  },
);

MinimapIndicator.displayName = 'MinimapIndicator';
