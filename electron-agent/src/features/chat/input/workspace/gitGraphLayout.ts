export const LANE_W = 14;
export const ROW_H = 30;
export const NODE_R = 4;
export const LANE_COLORS = ['#4c8bf5', '#3fb950', '#d29922', '#bc8cff', '#f778ba', '#56d4dd'];

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface GraphRow<T extends GraphCommit = GraphCommit> {
  commit: T;
  col: number;
  incoming: (string | null)[];
  outgoing: (string | null)[];
  parentCols: number[];
  mergedFrom: number[];
}

export interface GraphSegment {
  key: string;
  colorCol: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const laneColor = (col: number): string => LANE_COLORS[col % LANE_COLORS.length];
export const cx0 = (col: number): number => col * LANE_W + LANE_W / 2;

/**
 * 基于 parents 做 lane（列）分配：维护「每条 lane 期待出现的下一个 commit」，
 * 第一父接替当前 lane，额外父开新 lane，多个 lane 指向同一 commit 即合并。
 * 产出每行的入/出 lane 快照与分叉/合并列，供 SVG 画竖线 + 斜线。
 */
export function buildGraph<T extends GraphCommit>(log: T[]): { rows: GraphRow<T>[]; lanes: number } {
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

/**
 * 每行独立 SVG 的笔画：合入用顶→节点的斜线，分叉用节点→底的斜线。
 * 同一侧道若刚合入又立刻分出，不再画贯穿竖线（否则会和斜线叠成假连接）。
 */
export function rowSegments(row: GraphRow): GraphSegment[] {
  const mid = ROW_H / 2;
  const segs: GraphSegment[] = [];
  const mergeSet = new Set(row.mergedFrom);
  const forkSet = new Set(row.parentCols.filter((pc) => pc !== row.col));
  const colCount = Math.max(row.incoming.length, row.outgoing.length, row.col + 1);

  for (let i = 0; i < colCount; i++) {
    const hasIn = row.incoming[i] != null;
    const hasOut = row.outgoing[i] != null;
    const isMerge = mergeSet.has(i);
    const isFork = forkSet.has(i);

    if (isMerge) {
      segs.push({ key: `m${i}`, colorCol: i, x1: cx0(i), y1: 0, x2: cx0(row.col), y2: mid });
    } else if (hasIn) {
      segs.push({ key: `i${i}`, colorCol: i, x1: cx0(i), y1: 0, x2: cx0(i), y2: mid });
    }

    if (isFork) {
      segs.push({ key: `p${i}`, colorCol: i, x1: cx0(row.col), y1: mid, x2: cx0(i), y2: ROW_H });
    }
    const skipOutgoingVertical = isFork && (!hasIn || isMerge);
    if (hasOut && !skipOutgoingVertical) {
      segs.push({ key: `o${i}`, colorCol: i, x1: cx0(i), y1: mid, x2: cx0(i), y2: ROW_H });
    }
  }

  return segs;
}
