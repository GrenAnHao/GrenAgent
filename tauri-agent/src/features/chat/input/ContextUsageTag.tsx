import { Popover } from '@lobehub/ui';
import { TokenTag } from '@lobehub/ui/chat';
import { createStaticStyles, cssVar } from 'antd-style';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useSessionStats } from '../../../hooks/useSessionStats';
import { buildContextBreakdown, formatTokens, type ContextStats } from '../../../lib/sessionStats';

// pi exposes context-window occupancy + cumulative session tokens, not Cursor's
// per-category split. Honest render: a used/free window bar + a breakdown list
// (one row per item). Colors come from cssVar.
const SEG_COLOR: Record<string, string> = {
  used: cssVar.colorPrimary,
  free: cssVar.colorFillSecondary,
  'cache-read': cssVar.colorInfo,
  'cache-write': cssVar.colorFillTertiary,
  input: cssVar.colorSuccess,
  output: cssVar.colorWarning,
};

function statusColor(status: ContextStats['contextStatus']): string {
  if (status === 'danger') return cssVar.colorError;
  if (status === 'warning') return cssVar.colorWarning;
  return cssVar.colorPrimary;
}

function segColor(id: string, status: ContextStats['contextStatus']): string {
  if (id === 'used') return statusColor(status);
  return SEG_COLOR[id] ?? cssVar.colorTextQuaternary;
}

const styles = createStaticStyles(({ css }) => ({
  card: css`
    width: 300px;
    font-size: 12px;
  `,
  head: css`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
  `,
  title: css`
    font-weight: 600;
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  total: css`
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  bar: css`
    display: flex;
    width: 100%;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: ${cssVar.colorFillSecondary};
    margin-bottom: 10px;
  `,
  groupLabel: css`
    color: ${cssVar.colorTextQuaternary};
    font-size: 11px;
    margin: 8px 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  `,
  dot: css`
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex: none;
  `,
  rowLabel: css`
    flex: 1;
    color: ${cssVar.colorTextSecondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rowValue: css`
    color: ${cssVar.colorText};
    font-variant-numeric: tabular-nums;
  `,
  empty: css`
    color: ${cssVar.colorTextTertiary};
    padding: 4px 0;
  `,
}));

function UsageCard({ stats }: { stats: ContextStats }) {
  const items = buildContextBreakdown(stats);
  const contextItems = items.filter((i) => i.group === 'context');
  const sessionItems = items.filter((i) => i.group === 'session');
  const usedText = stats.contextKnown && stats.contextUsed != null ? formatTokens(stats.contextUsed) : '—';
  const limitText = stats.contextLimit > 0 ? formatTokens(stats.contextLimit) : '—';

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>上下文用量</span>
        <span className={styles.total}>
          {stats.contextKnown ? `${Math.round(stats.contextPercent)}% 已用` : '未知'} · ~{usedText} / {limitText}
        </span>
      </div>

      {stats.contextKnown && stats.contextLimit > 0 ? (
        <div className={styles.bar}>
          {contextItems.map((i) => (
            <div key={i.id} style={{ width: `${i.percent}%`, background: segColor(i.id, stats.contextStatus) }} />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>暂无上下文窗口数据(发送一条消息后即可统计)。</div>
      )}

      {contextItems.length > 0 && (
        <>
          <div className={styles.groupLabel}>窗口占用</div>
          {contextItems.map((i) => (
            <div key={i.id} className={styles.row}>
              <span className={styles.dot} style={{ background: segColor(i.id, stats.contextStatus) }} />
              <span className={styles.rowLabel}>{i.label}</span>
              <span className={styles.rowValue}>{formatTokens(i.tokens)}</span>
            </div>
          ))}
        </>
      )}

      {sessionItems.length > 0 && (
        <>
          <div className={styles.groupLabel}>会话累计</div>
          {sessionItems.map((i) => (
            <div key={i.id} className={styles.row}>
              <span className={styles.dot} style={{ background: segColor(i.id, stats.contextStatus) }} />
              <span className={styles.rowLabel}>{i.label}</span>
              <span className={styles.rowValue}>{i.meta ?? formatTokens(i.tokens)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** ChatInput 上的上下文用量指示:TokenTag 圆环 + 点击弹出明细气泡卡片。 */
export function ContextUsageTag() {
  const { workspace } = useAgentStoreContext();
  const { stats } = useSessionStats(workspace);

  if (!stats) return null;

  const maxValue = Math.max(1, stats.contextLimit);
  const value = Math.min(maxValue, Math.max(0, stats.contextUsed ?? 0));

  return (
    <Popover arrow={false} content={<UsageCard stats={stats} />} placement="topRight" trigger="click">
      <TokenTag maxValue={maxValue} mode="used" showInfo value={value} />
    </Popover>
  );
}
