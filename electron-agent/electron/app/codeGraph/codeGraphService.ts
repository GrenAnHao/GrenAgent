import { CodeGraphInstancePool } from './instancePool';
import { CodeGraphSyncRunner } from './syncRunner';
import { isIndexed, probeProjects, type ProjectIndexState } from './indexProbe';

export interface CodeGraphStatusView {
  workspace: string;
  connected: boolean;
  indexed: boolean;
  state?: string;
  files?: number;
  nodes?: number;
  edges?: number;
}

export interface CodeSearchHit { file: string; line?: number; symbol?: string; snippet?: string }
export interface CodeSearchView { workspace: string; available: boolean; results: CodeSearchHit[]; message?: string }

export interface CodeGraphServiceOptions {
  /** 已注册项目路径的提供者（由渲染层通过 IPC 报送，主进程不自行猜测项目集合）。 */
  listWorkspaces: () => string[];
  pool?: CodeGraphInstancePool;
  syncRunner?: CodeGraphSyncRunner;
}

/** 聚合索引探测、同步执行与查询连接池，作为 runtime 的 codeRetrieval provider。 */
export class CodeGraphService {
  private readonly pool: CodeGraphInstancePool;
  private readonly syncRunner: CodeGraphSyncRunner;

  constructor(private readonly options: CodeGraphServiceOptions) {
    this.pool = options.pool ?? new CodeGraphInstancePool();
    this.syncRunner = options.syncRunner ?? new CodeGraphSyncRunner();
  }

  projects(): ProjectIndexState[] {
    return probeProjects(this.options.listWorkspaces());
  }

  status(workspace: string): CodeGraphStatusView {
    const indexed = isIndexed(workspace);
    return { workspace, connected: indexed, indexed, state: indexed ? 'indexed' : 'unavailable' };
  }

  async search(workspace: string, query: string, limit: number): Promise<CodeSearchView> {
    if (!isIndexed(workspace)) {
      return { workspace, available: false, results: [], message: 'CodeGraph index is not initialized for this workspace' };
    }
    try {
      const raw = await this.pool.call(workspace, 'codegraph_search', { query, limit });
      return { workspace, available: true, results: parseHits(raw) };
    } catch (error) {
      return { workspace, available: false, results: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 供 runtime 的 jobRunners 使用：同步完成后让池子丢弃旧连接。 */
  async runSync(jobId: string, workspace: string): Promise<void> {
    await this.syncRunner.run(jobId, workspace);
    await this.pool.invalidate(workspace);
  }

  cancelSync(jobId: string): void {
    this.syncRunner.cancel(jobId);
  }

  close(): Promise<void> {
    return this.pool.closeAll();
  }
}

/**
 * CodeGraph MCP 返回 `{ content: [{ type:'text', text }] }`，text 里是它自己的
 * 格式化输出。这里只做保守解析：能解析成 JSON 数组就按结构取字段，否则按
 * `path:line` 前缀逐行提取，解析不出来就返回空列表（由 UI 显示"无结果"）。
 */
function parseHits(raw: unknown): CodeSearchHit[] {
  const text = extractText(raw);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => (item && typeof item === 'object' ? [toHit(item as Record<string, unknown>)] : []));
    }
  } catch {
    // 非 JSON：走行解析。
  }
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([^\s:]+):(\d+)\s*(.*)$/.exec(line);
    return match ? [{ file: match[1], line: Number(match[2]), snippet: match[3] || undefined }] : [];
  });
}

function extractText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { text: string } => Boolean(block) && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function toHit(item: Record<string, unknown>): CodeSearchHit {
  return {
    file: typeof item.file === 'string' ? item.file : typeof item.path === 'string' ? item.path : '',
    line: typeof item.line === 'number' ? item.line : undefined,
    symbol: typeof item.symbol === 'string' ? item.symbol : typeof item.name === 'string' ? item.name : undefined,
    snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
  };
}
