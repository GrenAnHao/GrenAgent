import { invoke } from '@tauri-apps/api/core';
import type { RichGraph } from './codeGraphTypes';

/** @deprecated Use RichGraph from codeGraphTypes instead. */
export interface FileGraphNode {
  path: string;
  language: string;
  nodeCount: number;
}

/** @deprecated Use RichGraph from codeGraphTypes instead. */
export interface FileGraphEdge {
  source: string;
  target: string;
  weight: number;
}

/** @deprecated Use RichGraph from codeGraphTypes instead. */
export interface FileGraph {
  nodes: FileGraphNode[];
  edges: FileGraphEdge[];
}

/** @deprecated Use getRichGraph instead. */
export function getFileGraph(workspace: string, limit?: number): Promise<FileGraph> {
  return invoke<FileGraph>('code_intel_file_graph', { workspace, limit: limit ?? null });
}

export function getRichGraph(workspace: string, limit?: number): Promise<RichGraph> {
  return invoke<RichGraph>('code_intel_rich_graph', { workspace, limit: limit ?? null });
}
