import { createStaticStyles, cssVar } from 'antd-style';
import { LoaderCircle } from 'lucide-react';

const LABELS = {
  preparing: '正在准备压缩上下文…',
  running: '正在压缩上下文…',
  unconfirmed: '暂时无法确认压缩状态',
  done: '上下文已压缩',
} as const;

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 0;
  `,
  line: css`
    flex: 1 1 auto;
    height: 1px;
    background: ${cssVar.colorBorderSecondary};
  `,
  label: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    line-height: 1.55;
    text-align: center;
  `,
  spinner: css`
    flex: none;
    @media (prefers-reduced-motion: no-preference) {
      animation: compactionSpin 1s linear infinite;
    }
    @keyframes compactionSpin {
      to { transform: rotate(360deg); }
    }
  `,
}));

/** 进行中与历史完成标记用同一套分隔线；无法确认时不显示运行图标。 */
export function CompactionDivider({ phase }: { phase: keyof typeof LABELS }) {
  const busy = phase === 'preparing' || phase === 'running';
  return (
    <div className={styles.row} role="status" data-testid={phase === 'done' ? 'compaction-done' : 'compaction-indicator'}>
      <span className={styles.line} aria-hidden />
      <span className={styles.label}>
        {busy ? <LoaderCircle size={14} className={styles.spinner} aria-hidden data-testid="compaction-spinner" /> : null}
        <span>{LABELS[phase]}</span>
      </span>
      <span className={styles.line} aria-hidden />
    </div>
  );
}
