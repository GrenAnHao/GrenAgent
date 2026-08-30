import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { VList } from 'virtua';
import { pi, type GitLogEntry } from '../../../../lib/pi';

const LANE_W = 14;
const ROW_H = 30;
const NODE_R = 4;
// lane 配色（按列循环），与主题 accent 一致，纯色无 emoji。
const LANE_COLORS = ['#4c8bf5', '#3fb950', '#d29922', '#bc8cff', '#f778ba', '#56d4dd'];

interface GraphRow {
  commit: GitLogEntry;
  col: number;
  incoming: (string | null)[];
  outgoing: (string | null)[];
  parentCols: number[];
  mergedFrom: number[];
}

/**
 * 基于 parents 做 lane（列）分配：维护「每条 lane 期待出现的下一个 commit」，
 * 第一父接替当前 lane，额外父开新 lane，多个 lane 指向同一 commit 即合并。
 * 产出每行的入/出 lane 快照与分叉/合并列，供 SVG 画竖线 + 斜线。
 */
function buildGraph(log: GitLogEntry[]): { rows: GraphRow[]; lanes: number } {
  const lanes: (string | null)[] = [];
  let maxLanes = 1;

  const rows = log.map((commit) => {
    let col = lanes.findIndex((h) => h === commit.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
    }
    lanes[col] = commit.hash;
    const incoming = lanes.slice();

    const mergedFrom: number[] = [];
    lanes.forEach((h, i) => {
      if (h === commit.hash && i !== col) {
        mergedFrom.push(i);
        lanes[i] = null;
      }
    });

    const parentCols: number[] = [];
    if (commit.parents.length === 0) {
      lanes[col] = null;
    } else {
      commit.parents.forEach((p, idx) => {
        if (idx === 0) {
          lanes[col] = p;
          parentCols.push(col);
          return;
        }
        let pc = lanes.findIndex((h) => h === p);
        if (pc === -1) {
          pc = lanes.indexOf(null);
          if (pc === -1) {
            pc = lanes.length;
            lanes.push(null);
          }
        }
        lanes[pc] = p;
        parentCols.push(pc);
      });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    const outgoing = lanes.slice();
    maxLanes = Math.max(maxLanes, incoming.length, outgoing.length, col + 1);

    return { commit, col, incoming, outgoing, parentCols, mergedFrom };
  });

  return { rows, lanes: maxLanes };
}

const laneColor = (col: number): string => LANE_COLORS[col % LANE_COLORS.length];
const cx0 = (col: number): number => col * LANE_W + LANE_W / 2;

function RowGraphic({ row, lanes }: { row: GraphRow; lanes: number }) {
  const mid = ROW_H / 2;
  const lines: ReactNode[] = [];

  // 上半：进入本行的各 lane 竖线
  row.incoming.forEach((h, i) => {
    if (h === null) return;
    lines.push(
      <line key={`i${i}`} stroke={laneColor(i)} strokeWidth={1.5} x1={cx0(i)} x2={cx0(i)} y1={0} y2={mid} />,
    );
  });
  // 合并：其它 lane 在中线汇入本 commit 所在列
  row.mergedFrom.forEach((i) => {
    lines.push(
      <line key={`m${i}`} stroke={laneColor(i)} strokeWidth={1.5} x1={cx0(i)} x2={cx0(row.col)} y1={mid} y2={mid} />,
    );
  });
  // 下半：离开本行的各 lane 竖线
  row.outgoing.forEach((h, i) => {
    if (h === null) return;
    lines.push(
      <line key={`o${i}`} stroke={laneColor(i)} strokeWidth={1.5} x1={cx0(i)} x2={cx0(i)} y1={mid} y2={ROW_H} />,
    );
  });
  // 分叉：本 commit 到额外父所在列的斜线
  row.parentCols.forEach((pc) => {
    if (pc === row.col) return;
    lines.push(
      <line key={`p${pc}`} stroke={laneColor(pc)} strokeWidth={1.5} x1={cx0(row.col)} x2={cx0(pc)} y1={mid} y2={ROW_H} />,
    );
  });

  return (
    <svg height={ROW_H} style={{ flex: 'none' }} width={lanes * LANE_W}>
      {lines}
      <circle cx={cx0(row.col)} cy={mid} fill={laneColor(row.col)} r={NODE_R} />
    </svg>
  );
}

const g = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;

    width: 100%;
    height: 520px;
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

function GraphView({ workspace }: { workspace: string }) {
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    pi.getGitLogGraph(workspace, 80)
      .then((l) => {
        if (alive) setLog(l);
      })
      .catch(() => {
        if (alive) setLog([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const { rows, lanes } = useMemo(() => buildGraph(log), [log]);

  if (loading) {
    return <div className={g.center}>加载中…</div>;
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
        <VList className={g.list} data={rows} style={{ height: '100%' }}>
          {(row: GraphRow) => (
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
    </div>
  );
}

/**
 * Git 提交图谱模态框：lane 连线 + ref 标签 + 日期/作者/提交列。受控组件，由分支气泡里的
 * 「Git 图谱」入口开关；懒加载 + 虚拟化（打开才拉取与渲染）。
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
      title="Git 图谱"
      width={880}
      onCancel={onClose}
    >
      {open ? <GraphView workspace={workspace} /> : null}
    </Modal>
  );
}
