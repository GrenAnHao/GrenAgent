import { useEffect, useMemo } from 'react';
import { cssVar, useTheme } from 'antd-style';
import {
  ReactFlow, ReactFlowProvider, Background, Controls,
  useReactFlow, MarkerType, Handle, Position,
  type NodeTypes, type Node, type Edge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { EdgeKind, RichGraph } from '../../../../lib/codeGraphTypes';
import { topLevelDir } from '../../../../lib/codeGraphLayout';

// 目录分类色：按目录名散列取色，用来一眼分辨节点归属，刻意不跟主题走——同一目录在明暗两套下
// 必须是同一个色相才认得出。只画成小圆点（非文字），中间调在明暗底上都看得见。
const DIR_PALETTE = [
  '#60a5fa','#818cf8','#34d399','#fb923c',
  '#f472b6','#a78bfa','#38bdf8','#4ade80','#facc15','#f87171',
];
function dirColor(dir: string): string {
  let h = 0;
  for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) & 0xffff;
  return DIR_PALETTE[h % DIR_PALETTE.length];
}
function basename(p: string) { return p.split(/[/\\]/).at(-1) ?? p; }

// 边类型分类色，同上：身份色，不跟主题走（GraphToolbar 的图例用同一套色相）。
const EDGE_COLOR: Record<EdgeKind, string> = {
  'import-value': '#3b82f6',
  'import-type':  '#6366f1',
  'reexport':     '#10b981',
  'dynamic':      '#f59e0b',
  'call':         '#06b6d4',
  'circular':     '#ef4444',
};

// Focused rendering: by default only the strongest few edges are drawn as a
// skeleton; a node's full n-hop neighborhood is revealed on selection. This keeps
// the canvas from painting thousands of SVG paths at once (the old flat render
// drew the entire graph and was unusably slow on large repos).
const DEFAULT_SKELETON_EDGES = 80;

type FileNodeData = { label: string; color: string; dotSize: number; dimmed: boolean };

// Edges only attach to a node's <Handle> anchors. Custom nodes ship no handles
// by default, so without these the dependency lines never render. Kept invisible
// and non-interactive (the graph is read-only) — they exist purely as anchors.
const HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
  pointerEvents: 'none',
};

function FileNode({ data }: NodeProps & { data: FileNodeData }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: data.dimmed ? 0.15 : 1 }}>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <div style={{ width: data.dotSize, height: data.dotSize, borderRadius: '50%', background: data.color, flexShrink: 0 }} />
      <span style={{ fontSize: 10, color: cssVar.colorText, fontFamily: cssVar.fontFamilyCode, whiteSpace: 'nowrap' }}>
        {data.label}
      </span>
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}
const nodeTypes: NodeTypes = { file: FileNode as NodeTypes['file'] };

interface Props {
  graph: RichGraph;
  highlightSet: Set<string>;
  pathEdges: Set<string>;
  visibleKinds?: Set<EdgeKind>;
  searchQuery?: string;
  onNodeClick(id: string, shiftKey?: boolean): void;
  onPaneClick(): void;
}

function Inner({ graph, highlightSet, pathEdges, visibleKinds, searchQuery, onNodeClick, onPaneClick }: Props) {
  const { setCenter } = useReactFlow();
  // React Flow 自己的 chrome（Controls 按钮、Background 网点）不吃 antd 变量，得显式喂当前主题。
  // Background 的 color 最终落到 SVG 的 fill 属性上，属性里 var() 不会被解析，所以必须用
  // useTheme() 的真实色值（antd 的 useToken 返回 realToken），不能用 cssVar.*。
  const theme = useTheme();

  const hasAny = highlightSet.size > 0;
  const sq = (searchQuery ?? '').trim().toLowerCase();

  const nodes: Node[] = useMemo(() =>
    graph.nodes.map((n) => {
      const inSearch = sq ? basename(n.path).toLowerCase().includes(sq) : false;
      const inHL = highlightSet.has(n.path) || (!hasAny && inSearch);
      const dimmed = (hasAny || sq.length > 0) && !inHL;
      return {
        id: n.path,
        type: 'file',
        position: { x: n.x, y: n.y },
        data: {
          label: basename(n.path),
          color: dirColor(topLevelDir(n.path)),
          dotSize: Math.min(14, Math.max(6, 5 + Math.log1p(n.inDegree) * 2)),
          dimmed,
        } satisfies FileNodeData,
      };
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [graph, highlightSet, searchQuery]);

  const edges: Edge[] = useMemo(() => {
    const colorOf = (kind: EdgeKind) => EDGE_COLOR[kind] ?? EDGE_COLOR['import-value'];
    const mk = (src: string, tgt: string, kind: EdgeKind, id: string, lit: boolean, faint: boolean): Edge => ({
      id,
      source: src,
      target: tgt,
      type: 'default',
      animated: false,
      style: { stroke: colorOf(kind), strokeWidth: lit ? 2 : 1, opacity: lit ? 1 : faint ? 0.32 : 0.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: colorOf(kind), width: 16, height: 16 },
    });

    // Candidate edges = real edges + synthesized circular edges, filtered by the
    // kind toggles. Circular edges are weighted highest so cycles survive the
    // skeleton cut.
    const CIRCULAR_W = Number.MAX_SAFE_INTEGER;
    const candidates = [
      ...graph.edges.map((e) => ({
        src: e.source, tgt: e.target, kind: e.kind, weight: e.weight,
        id: `${e.source}=>${e.target}:${e.kind}`,
      })),
      ...graph.circularPaths.flatMap((path) =>
        path.slice(0, -1).map((s, i) => ({
          src: s, tgt: path[i + 1], kind: 'circular' as EdgeKind, weight: CIRCULAR_W,
          id: `circ:${s}=>${path[i + 1]}`,
        })),
      ),
    ].filter((e) => !visibleKinds || visibleKinds.has(e.kind));

    // Focus mode: a node/path is active -> draw only its n-hop neighborhood
    // (both endpoints highlighted) plus any edges on the traced path.
    if (hasAny) {
      const out: Edge[] = [];
      for (const e of candidates) {
        const inPath = pathEdges.has(`${e.src}=>${e.tgt}`);
        const inHL = highlightSet.has(e.src) && highlightSet.has(e.tgt);
        if (inPath || inHL) out.push(mk(e.src, e.tgt, e.kind, e.id, inPath, false));
      }
      return out;
    }

    // Default ("not flat"): only the strongest few edges, as a faint skeleton.
    return [...candidates]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, DEFAULT_SKELETON_EDGES)
      .map((e) => mk(e.src, e.tgt, e.kind, e.id, false, true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, highlightSet, pathEdges, visibleKinds, hasAny]);

  // Pan to center of highlighted set on selection change
  useEffect(() => {
    if (!highlightSet.size) return;
    const pts = graph.nodes.filter((n) => highlightSet.has(n.path));
    if (!pts.length) return;
    const x = pts.reduce((s, n) => s + n.x, 0) / pts.length;
    const y = pts.reduce((s, n) => s + n.y, 0) / pts.length;
    setCenter(x, y, { duration: 400 });
  }, [graph.nodes, highlightSet, setCenter]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme.isDarkMode ? 'dark' : 'light'}
      fitView
      minZoom={0.02}
      maxZoom={5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      onNodeClick={(e, node) => onNodeClick(node.id, (e as React.MouseEvent).shiftKey)}
      onPaneClick={onPaneClick}
    >
      <Background color={theme.colorBorder} gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function GraphCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
