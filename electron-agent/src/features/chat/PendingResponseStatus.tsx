import { useEffect, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { cardStyles } from '../tools/cardStyles';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatPendingDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  if (hours > 0) return `${hours}小时${pad2(minutes)}分${pad2(seconds)}秒`;
  if (minutes > 0) return `${minutes}分${pad2(seconds)}秒`;
  return `${seconds}秒`;
}

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding-block: 2px;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.55;
  `,
  rowInherit: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: inherit;
    font-size: inherit;
    line-height: inherit;
  `,
  clock: css`
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextTertiary};
  `,
}));

/**
 * 还没收到首条响应，或任务进行中但末尾看起来已经停了。
 * 文案样式与「正在深度思考...」相同：呼吸点 + 灰色扫光。
 * startedAt 是这一轮真正开始的时刻；缺省时从挂上这一行起算。
 */
export function PendingResponseStatus({
  label,
  startedAt,
  dot = true,
  size = 'default',
}: {
  label: string;
  startedAt?: number;
  /** 行内已有状态图标时不再重复呼吸点。 */
  dot?: boolean;
  /** inherit 跟随外层字号，和同一行的其它状态对齐。 */
  size?: 'default' | 'inherit';
}) {
  const [mountedAt] = useState(() => Date.now());
  const origin = startedAt && startedAt > 0 ? startedAt : mountedAt;
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const tick = () => setElapsedMs(Math.max(0, Date.now() - origin));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [origin]);

  return (
    <div
      className={size === 'inherit' ? styles.rowInherit : styles.row}
      role="status"
      aria-live="polite"
      data-testid="pending-response"
      data-size={size}
    >
      {dot ? <span className={cardStyles.breathingDot} data-testid="pending-response-dot" /> : null}
      <span className={cardStyles.shinyText}>{label}</span>
      <span className={styles.clock} aria-hidden>
        {formatPendingDuration(elapsedMs)}
      </span>
    </div>
  );
}
