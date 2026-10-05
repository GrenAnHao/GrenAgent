import { Button, Progress, Slider } from 'antd';
import { Popover, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { FoldVertical } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AUTO_COMPACT_PERCENT_MAX,
  AUTO_COMPACT_PERCENT_MIN,
  readGlobalAutoCompactPercent,
  readSessionAutoCompactPercent,
  withSessionAutoCompactPercent,
} from '@extensions/compaction-policy/threshold';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useSessionStore } from '../../../store';
import { useSessionStats } from '../../../hooks/useSessionStats';
import { pi } from '../../../lib/pi';
import { hydrateSettingsValues } from '../../settings/useSettingsForm';
import {
  buildContextBreakdown,
  displayContextStats,
  formatTokens,
  type ContextStats,
} from '../../../lib/sessionStats';

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

function usedColor(percent: number): string {
  if (percent > 80) return cssVar.colorError;
  if (percent > 60) return cssVar.colorWarning;
  return cssVar.colorSuccess;
}

export function contextUsageTone(percent: number): 'success' | 'warning' | 'error' {
  if (percent > 80) return 'error';
  if (percent > 60) return 'warning';
  return 'success';
}

function segColor(id: string, percent: number): string {
  if (id === 'used') return usedColor(percent);
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
  compact: css`
    margin-top: 12px;
  `,
  auto: css`
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
  `,
  autoHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2px;
  `,
  autoLabel: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
  `,
  autoValue: css`
    color: ${cssVar.colorPrimary};
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    font-family: ${cssVar.fontFamilyCode};
  `,
  follow: css`
    margin-top: 2px;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
    line-height: 16px;
    text-align: start;
  `,
  followBtn: css`
    cursor: pointer;
    text-decoration: underline;
    &:hover {
      color: ${cssVar.colorText};
    }
  `,
}));

function AutoCompactSlider({ sessionPath }: { sessionPath: string | null | undefined }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<number | null>(null);
  const [sliding, setSliding] = useState(false);
  const writeSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    void pi.getSettings().then((next) => {
      if (alive) setSettings(next ?? {});
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionPath]);

  const global = readGlobalAutoCompactPercent(settings);
  const override = readSessionAutoCompactPercent(settings, sessionPath);
  const shown = draft ?? override ?? global;

  const persist = async (percent: number | null) => {
    if (!sessionPath) return;
    const seq = ++writeSeq.current;
    const current = await pi.getSettings();
    if (seq !== writeSeq.current) return;
    const next = withSessionAutoCompactPercent(current ?? {}, sessionPath, percent);
    await pi.setSettings(next);
    if (seq !== writeSeq.current) return;
    hydrateSettingsValues(next);
    setSettings(next);
    setDraft(null);
  };

  return (
    <div className={styles.auto}>
      <div className={styles.autoHead}>
        <span className={styles.autoLabel}>自动压缩触发值</span>
        <span className={styles.autoValue}>{shown}%</span>
      </div>
      <Slider
        aria-label="自动压缩触发值"
        disabled={!sessionPath}
        min={AUTO_COMPACT_PERCENT_MIN}
        max={AUTO_COMPACT_PERCENT_MAX}
        step={1}
        value={shown}
        tooltip={{ open: sliding, formatter: sliding ? (n) => `${n}%` : null }}
        style={{ margin: '4px 0 0' }}
        onChange={(value) => {
          setSliding(true);
          setDraft(value);
        }}
        onChangeComplete={(value) => {
          setSliding(false);
          void persist(value);
        }}
      />
      {override == null ? (
        <div className={styles.follow} data-testid="auto-compact-follow">跟随全局设置（{global}%）</div>
      ) : (
        <button
          type="button"
          className={`${styles.follow} ${styles.followBtn}`}
          data-testid="auto-compact-follow"
          onClick={() => void persist(null)}
        >
          跟随全局设置（{global}%）
        </button>
      )}
    </div>
  );
}

function UsageCard({
  stats,
  compacting,
  sessionPath,
  onCompact,
}: {
  stats: ContextStats;
  compacting: boolean;
  sessionPath: string | null | undefined;
  onCompact: () => void;
}) {
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
            <div key={i.id} style={{ width: `${i.percent}%`, background: segColor(i.id, stats.contextPercent) }} />
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
              <span className={styles.dot} style={{ background: segColor(i.id, stats.contextPercent) }} />
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
              <span className={styles.dot} style={{ background: segColor(i.id, stats.contextPercent) }} />
              <span className={styles.rowLabel}>{i.label}</span>
              <span className={styles.rowValue}>{i.meta ?? formatTokens(i.tokens)}</span>
            </div>
          ))}
        </>
      )}

      <AutoCompactSlider sessionPath={sessionPath} />
      <Button
        block
        className={styles.compact}
        disabled={compacting}
        icon={<Icon icon={FoldVertical} size={14} />}
        onClick={onCompact}
      >
        {compacting ? '正在压缩' : '压缩上下文'}
      </Button>
    </div>
  );
}

/** ChatInput 上的上下文用量指示:TokenTag 圆环 + 点击弹出明细气泡卡片。 */
export function ContextUsageTag() {
  const { workspace, store } = useAgentStoreContext();
  // 打开 / 切换会话时历史异步加载进 store；消息数变化即触发 stats 重拉，
  // 解决「打开旧会话首拉为 0（sidecar 会话尚未就绪）后再不更新」。
  const messageCount = store.useStore((s) => s.messages.length);
  const compacting = store.useStore((s) => Boolean(s.compacting));
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  // 按画面上这份会话取统计：同项目另一个会话在前景跑时，不能显示它的上下文用量。
  const { stats: fetched } = useSessionStats(workspace, messageCount, store.getLoadedSessionPath() ?? activeSessionPath);
  const stats = displayContextStats(fetched, !activeSessionPath);
  const sessionPath = store.getLoadedSessionPath() ?? activeSessionPath;
  const anchorRef = useRef<HTMLButtonElement>(null);
  // 碰撞盒用对话列，不用整窗：右栏开着时窗口右侧仍有像素，但那是内容，卡片不该盖上去。
  const [collisionBoundary, setCollisionBoundary] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const column = anchorRef.current?.closest('[data-chat-column]');
    setCollisionBoundary(column instanceof HTMLElement ? column : null);
  });

  if (!stats || messageCount === 0) return null;

  const tone = stats.contextKnown ? usedColor(stats.contextPercent) : cssVar.colorTextQuaternary;
  const percent = stats.contextKnown ? Math.min(100, Math.max(0, stats.contextPercent)) : 0;

  return (
    <Popover
      arrow={false}
      content={<UsageCard compacting={compacting} sessionPath={sessionPath} onCompact={() => void pi.compact(workspace)} stats={stats} />}
      placement="topLeft"
      positionerProps={{
        collisionAvoidance: { align: 'flip', fallbackAxisSide: 'none', side: 'flip' },
        collisionBoundary: collisionBoundary ?? undefined,
        collisionPadding: 8,
      }}
      trigger="click"
    >
      <button
        ref={anchorRef}
        type="button"
        aria-label="上下文用量"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginInlineStart: 2,
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          lineHeight: 0,
        }}
      >
        <Progress
          percent={percent}
          showInfo={false}
          size={14}
          strokeColor={tone}
          strokeWidth={14}
          trailColor={cssVar.colorFillSecondary}
          type="circle"
        />
      </button>
    </Popover>
  );
}
