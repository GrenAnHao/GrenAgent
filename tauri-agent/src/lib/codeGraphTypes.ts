export type EdgeKind =
  | 'import-value'
  | 'import-type'
  | 'reexport'
  | 'dynamic'
  | 'call'
  | 'circular';

export interface GraphNode {
  path: string;
  lines: number;
  exportCount: number;
  complexity: number;
  inDegree: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
}

export interface RichGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Cycle arrays derived by detectCycles(); never stored in edges. */
  circularPaths: string[][];
}
