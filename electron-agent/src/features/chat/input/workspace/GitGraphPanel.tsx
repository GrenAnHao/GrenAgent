import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { VList, type VListHandle } from 'virtua';
import { pi, type GitLogEntry } from '../../../../lib/pi';
import {
  buildGraph,
  cx0,
  LANE_W,
  NODE_R,
  ROW_H,
  laneColor,
  rowSegments,
  type GraphRow,
} from './gitGraphLayout';

function RowGraphic({ row, lanes }: { row: GraphRow<GitLogEntry>; lanes: number }) {
  const mid = ROW_H / 2;
  return (
    <svg height={ROW_H} style={{ flex: 'none' }} width={lanes * LANE_W}>
      {rowSegments(row).map((seg) => (
        <line
          key={seg.key}
          stroke={laneColor(seg.colorCol)}
          strokeWidth={1.5}
          x1={seg.x1}
          x2={seg.x2}
          y1={seg.y1}
          y2={seg.y2}
        />
      ))}
      <circle cx={cx0(row.col)} cy={mid} fill={laneColor(row.col)} r={NODE_R} />
    </svg>
  );
}

const g = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;

    width: 100%;
    /* lobe Modal body 默认 maxHeight 75dvh、底部内边距 16px：矮窗口里超出就会在弹窗外侧多一条滚动条。 */
    height: min(520px, calc(75dvh - 16px));
  `,
  head: css`
    display: flex;
    gap: 8px;
    align-items: center;

    padding: 0 6px 8px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  hCell: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  body: css`
    flex: 1;
    min-height: 0;
  `,
  list: css`
    scrollbar-width: thin;
    padding: 6px 0;
  `,
  row: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 0 6px;
  `,
  msg: css`
    overflow: hidden;
    font-size: 12.5px;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cellDate: css`
    flex: none;
    width: 110px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  cellAuthor: css`
    overflow: hidden;
    flex: none;
    width: 120px;
    font-size: 11.5px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cellHash: css`
    flex: none;
    width: 72px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  ref: css`
    margin-right: 6px;
    padding: 1px 6px;
    border-radius: 9px;
    font-size: 10px;
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
  `,
  refHead: css`
    color: ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
  `,
  foot: css`
    flex: none;
    padding: 6px 6px 0;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  center: css`
    display: flex;
    align-items: center;
    justify-content: center;

    height: 360px;
    font-size: 12.5px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

/** unix 秒 → MM/DD HH:mm（对齐图2 的绝对时间显示）。 */
function fmtDate(ts: number): string {
  const date = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(date.getMonth() + 1)}/${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 每页提交数。滚到距底部不足 PREFETCH_ROWS 行时拉下一页，直到某页不满。 */
const PAGE = 300;
const PREFETCH_ROWS = 60;

function GraphView({ workspace }: { workspace: string }) {
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<VListHandle>(null);
  // 换工作区就换一代；晚到的旧响应按代号丢弃。
  const genRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const gen = ++genRef.current;
    busyRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setLog([]);
    setHasMore(false);
    pi.getGitLogGraph(workspace, PAGE, 0)
      .then((page) => {
        if (gen !== genRef.current) return;
        setLog(page);
        setHasMore(page.length === PAGE);
      })
      .catch((e: unknown) => {
        if (gen === genRef.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
    return () => {
      genRef.current += 1;
    };
  }, [workspace]);

  const loadMore = useCallback(() => {
    if (busyRef.current || !hasMore) return;
    busyRef.current = true;
    setLoadingMore(true);
    const gen = genRef.current;
    pi.getGitLogGraph(workspace, PAGE, log.length)
      .then((page) => {
        if (gen !== genRef.current) return;
        // 翻页间隔里有新提交时 skip 会错位，按 hash 去重，避免同一提交画两次。
        setLog((prev) => {
          const seen = new Set(prev.map((c) => c.hash));
          return prev.concat(page.filter((c) => !seen.has(c.hash)));
        });
        setHasMore(page.length === PAGE);
      })
      .catch(() => {
        if (gen === genRef.current) setHasMore(false);
      })
      .finally(() => {
        if (gen !== genRef.current) return;
        busyRef.current = false;
        setLoadingMore(false);
      });
  }, [workspace, hasMore, log.length]);

  const onScroll = useCallback(
    (offset: number) => {
      const list = listRef.current;
      if (!list) return;
      if (offset + list.viewportSize >= list.scrollSize - PREFETCH_ROWS * ROW_H) loadMore();
    },
    [loadMore],
  );

  const { rows, lanes } = useMemo(() => buildGraph(log), [log]);

  if (loading) {
    return <div className={g.center}>加载中…</div>;
  }
  if (error) {
    return <div className={g.center}>加载失败：{error}</div>;
  }
  if (rows.length === 0) {
    return <div className={g.center}>无提交记录</div>;
  }

  // 图列宽 = 实际 lane 宽，但不窄于 40px 以容下表头「图」标签；表头与各行共用同一宽度保证对齐。
  const colGraph = Math.max(lanes * LANE_W, 40);

  return (
    <div className={g.wrap}>
      <div className={g.head}>
        <span style={{ width: colGraph, flex: 'none' }}>图</span>
        <span className={g.hCell} style={{ flex: 1 }}>
          描述
        </span>
        <span className={g.hCell} style={{ width: 110, flex: 'none' }}>
          日期
        </span>
        <span className={g.hCell} style={{ width: 120, flex: 'none' }}>
          作者
        </span>
        <span className={g.hCell} style={{ width: 72, flex: 'none' }}>
          提交
        </span>
      </div>
      <div className={g.body}>
        <VList ref={listRef} className={g.list} data={rows} style={{ height: '100%' }} onScroll={onScroll}>
          {(row: GraphRow<GitLogEntry>) => (
            <div key={row.commit.hash} className={g.row} style={{ minHeight: ROW_H }}>
              <div style={{ width: colGraph, flex: 'none', display: 'flex', alignItems: 'center' }}>
                <RowGraphic lanes={lanes} row={row} />
              </div>
              <span className={g.msg} style={{ flex: 1 }}>
                {row.commit.refs.map((r) => (
                  <span key={r} className={cx(g.ref, /HEAD/.test(r) && g.refHead)}>
                    {r}
                  </span>
                ))}
                {row.commit.subject}
              </span>
              <span className={g.cellDate}>{fmtDate(row.commit.timestamp)}</span>
              <span className={g.cellAuthor} title={row.commit.author}>
                {row.commit.author}
              </span>
              <span className={g.cellHash}>{row.commit.shortHash}</span>
            </div>
          )}
        </VList>
      </div>
      <div className={g.foot} data-testid="git-history-status">
        {loadingMore
          ? `已加载 ${rows.length} 条，正在加载更多…`
          : hasMore
            ? `已加载 ${rows.length} 条，向下滚动加载更多`
            : `共 ${rows.length} 条提交（含本地、远端分支与 tag）`}
      </div>
    </div>
  );
}

/**
 * Git 历史模态框：lane 连线 + ref 标签 + 日期/作者/提交列。受控组件，由分支气泡里的
 * 「Git 历史」入口开关；打开才拉取，按页滚动加载，列表虚拟化。
 */
export function GitGraphModal({
  workspace,
  open,
  onClose,
}: {
  workspace: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      data-testid="git-graph-modal"
      footer={null}
      open={open}
      title="Git 历史"
      width={880}
      onCancel={onClose}
    >
      {open ? <GraphView workspace={workspace} /> : null}
    </Modal>
  );
}
