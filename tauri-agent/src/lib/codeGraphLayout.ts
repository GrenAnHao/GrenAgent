import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export interface NodePosition {
  x: number;
  y: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  dir: string;
}

export interface ForceLayoutOptions {
  /** 同步 tick 次数；越大越收敛，越慢。 */
  iterations?: number;
  /** 节点间距基准，决定整体铺开尺寸。 */
  spacing?: number;
}

/** 取顶层目录作为聚类键（无目录的根文件归到 '·'）。 */
export function topLevelDir(path: string): string {
  const seg = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return seg.length > 1 ? seg[0] : '·';
}

/**
 * 纯函数：目录聚类力导布局。同一顶层目录的文件被各自的锚点拉到一起形成「岛」，
 * 强斥力 + 防重叠保证节点不糊在一起，弱连线避免整图塌缩。无 React / DOM，便于单测。
 * 种子位置按目录锚点 + 索引确定性抖动，保证结果稳定（同输入同布局）。
 */
export function computeForceLayout(
  graph: { nodes: { path: string }[]; edges: { source: string; target: string }[] },
  opts: ForceLayoutOptions = {},
): Map<string, NodePosition> {
  const n = graph.nodes.length;
  if (n === 0) return new Map();

  const spacing = opts.spacing ?? 190;
  const iterations = opts.iterations ?? 420;
  const size = Math.max(1000, Math.sqrt(n) * spacing);
  const cx = size / 2;
  const cy = size / 2;

  const ids = new Set(graph.nodes.map((nd) => nd.path));
  const dirs = Array.from(new Set(graph.nodes.map((nd) => topLevelDir(nd.path))));
  const radius = size * 0.42;
  const anchor = new Map<string, NodePosition>();
  dirs.forEach((d, i) => {
    // 单目录时锚在中心，多目录均匀分布在大圆上。
    const a = dirs.length <= 1 ? 0 : (i / dirs.length) * Math.PI * 2;
    anchor.set(d, {
      x: dirs.length <= 1 ? cx : cx + Math.cos(a) * radius,
      y: dirs.length <= 1 ? cy : cy + Math.sin(a) * radius,
    });
  });

  const nodes: SimNode[] = graph.nodes.map((nd, i) => {
    const dir = topLevelDir(nd.path);
    const an = anchor.get(dir)!;
    // 确定性抖动：避免初始重合，又不引入随机不稳定。
    const jx = ((i * 53) % 100) - 50;
    const jy = ((i * 97) % 100) - 50;
    return { id: nd.path, dir, x: an.x + jx, y: an.y + jy };
  });
  const links: SimulationLinkDatum<SimNode>[] = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(nodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((d) => d.id)
        .distance(120)
        .strength(0.08),
    )
    .force('charge', forceManyBody().strength(-450))
    .force('collide', forceCollide(70))
    .force('x', forceX<SimNode>((d) => anchor.get(d.dir)?.x ?? cx).strength(0.13))
    .force('y', forceY<SimNode>((d) => anchor.get(d.dir)?.y ?? cy).strength(0.13))
    .force('center', forceCenter(cx, cy).strength(0.02))
    .stop();

  sim.tick(iterations);

  const pos = new Map<string, NodePosition>();
  for (const nd of nodes) {
    pos.set(nd.id, { x: Math.round(nd.x ?? 0), y: Math.round(nd.y ?? 0) });
  }
  return pos;
}
