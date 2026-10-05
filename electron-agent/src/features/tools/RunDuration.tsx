import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useEffect, useState } from 'react';
import { formatRunDuration } from './bashCardModel';

const styles = createStaticStyles(({ css }) => ({
  duration: css`
    margin-inline-start: 4px;
    color: ${cssVar.colorTextQuaternary};
    font-variant-numeric: tabular-nums;
  `,
}));

/**
 * 命令行工具行里紧跟工具名的运行时长（`bash · 10s · 描述`）：运行中每秒自增，结束后定格在
 * reducer 记下的执行耗时。自带 1s 定时器（不靠父级重渲染驱动）——工具段在 status/args/result
 * 不变时被 MemoSegment 拦住，计时必须由这里自己推进。
 */
export const RunDuration = memo(function RunDuration({
  startedAt,
  durationMs,
  running,
}: {
  startedAt?: number;
  durationMs?: number;
  running: boolean;
}) {
  const live = running && startedAt != null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, startedAt]);

  const ms = live ? Math.max(0, now - startedAt) : durationMs;
  if (ms == null) return null;
  return (
    <span className={styles.duration} data-testid="tool-run-duration">
      · {formatRunDuration(ms)}
    </span>
  );
});
