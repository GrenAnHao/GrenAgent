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
    /** 只在索引落后于磁盘时给出（同步在跑 / 排队 / 监听报过的改动还没进索引）。 */
    meta?: CodeRetrievalMeta;
  };
}

export interface CodeRetrievalMeta {
  servingStale: true;
  /** 这次应答用的索引是第几次成功提交（本进程内单调）。 */
  generation: number;
  phase: string;
  /** 监听报过、还没进索引的文件数与前几个路径（项目内相对路径）。 */
  pendingFiles: number;
  files: string[];
}
