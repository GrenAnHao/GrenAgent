import type { Edge, Node } from '@colbymchenry/codegraph';

export interface CodeRetrievalRow {
  id?: string;
  file?: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  kind?: string;
  snippet?: string;
}

export interface CodeRetrievalResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  structuredContent: {
    schemaVersion: 1;
    rows: CodeRetrievalRow[];
    nodes: Node[];
    edges: Edge[];
    extra?: Record<string, unknown>;
  };
}
