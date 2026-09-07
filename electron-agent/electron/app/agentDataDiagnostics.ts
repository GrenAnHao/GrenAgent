import { statSync } from 'node:fs';
import { relative } from 'node:path';
import type { DiagnosticItem, DiagnosticReport } from '../agentData/operationsContracts';
import type { WikiStore } from '../agentData/wikiStore';
import type { WikiLibraryStore } from '../agentData/wikiLibraryStore';
import { wikiHash } from '../agentData/wikiFiles';

export interface CodeDiagnosticStatus {
  connected?: boolean; indexed?: boolean; state?: string; cliAvailable?: boolean; sdkAvailable?: boolean; message?: string;
  files?: number; nodes?: number; edges?: number;
}
export interface AgentDataDiagnosticsOptions {
  wiki: WikiStore; libraries: WikiLibraryStore;
  /** Only known workspaces and status probes are allowed; never initialize or sync an index. */
  codeProjects: () => Array<{ workspace: string; indexed?: boolean }>;
  codeStatus: (workspace: string) => CodeDiagnosticStatus | Promise<CodeDiagnosticStatus>;
}

export class AgentDataDiagnostics {
  private readonly issued = new Map<string, DiagnosticItem>();

  constructor(private readonly options: AgentDataDiagnosticsOptions) {}

  async check(): Promise<DiagnosticReport> {
    const checkedAt = Date.now(); const items: DiagnosticItem[] = [];
    this.issued.clear();
    try {
      for (const item of this.options.wiki.inspect()) {
        const view = { ...item, checkedAt };
        if (view.path || view.action === 'open_file') {
          try {
            view.path = this.safeOpenPath(view);
            if (view.action === 'open_file') this.issued.set(view.id, { ...view });
          } catch { delete view.path; if (view.action === 'open_file') delete view.action; }
        }
        items.push(view);
      }
    } catch { items.push({ id: 'wiki:unchecked', checkedAt, state: 'unchecked', message: '无法读取知识库状态，本次未完成检查' }); }
    let projects: ReturnType<AgentDataDiagnosticsOptions['codeProjects']>;
    try { projects = this.options.codeProjects(); }
    catch { projects = []; }
    if (!projects.length) items.push({ id: 'code:unchecked', checkedAt, state: 'unchecked', message: '尚无可检查的已知代码项目；未启动 CodeGraph 或创建索引' });
    for (const workspace of new Set(projects.map((project) => project.workspace))) {
      const item: DiagnosticItem = { id: `code:${wikiHash(workspace)}`, resource: { type: 'project', id: workspace }, checkedAt, state: 'unchecked', message: 'CodeGraph 仅有未验证的状态，未启动连接或重建索引' };
      try {
        const status = await this.options.codeStatus(workspace);
        const state = status.state?.toLowerCase().replace(/-/g, '_');
        if (status.sdkAvailable === false || state === 'sdk_unavailable') {
          item.state = 'action_required'; item.message = `内置 CodeGraph SDK 不可用，请检查应用安装包：${status.message ?? '缺少平台依赖'}`;
        } else if (['partial', 'failed', 'stale'].includes(state ?? '')) {
          item.state = 'action_required'; item.message = `CodeGraph 索引需要检查（${state}）；可在代码面板显式同步。${status.message ?? ''}`;
        } else if (state === 'indexing') {
          item.message = 'CodeGraph 正在更新索引，完成后再检查';
        } else if (status.cliAvailable === false || ['cli_missing', 'missing_cli', 'command_not_found', 'codegraph_missing'].includes(state ?? '')) {
          item.state = 'action_required'; item.action = 'configure_codegraph'; item.message = '已知 CodeGraph CLI 不可用，请检查配置；诊断未安装或启动 CLI';
        } else if (status.connected === true && status.indexed === true && [status.files, status.nodes, status.edges].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) {
          item.state = 'ok'; item.message = `现有只读状态可用：${status.files} 个文件、${status.nodes} 个节点、${status.edges} 条边；未执行实时查询`;
        } else if (status.indexed === false) item.message = '当前未发现已验证的 CodeGraph 索引；未启动连接或自动创建索引';
      } catch { item.message = '无法读取现有 CodeGraph 状态，本次未检查连接或索引内容'; }
      items.push(item);
    }
    return { items, checkedAt };
  }

  /** Renderer supplies a diagnostic ID, never a filesystem path. */
  async resolveOpenPath(id: string): Promise<string> {
    const item = typeof id === 'string' ? this.issued.get(id) : undefined;
    if (!item) throw new Error('INVALID_DIAGNOSTIC: invalid diagnostic ID');
    try { return this.safeOpenPath(item); }
    catch (error) { throw new Error(`INVALID_DIAGNOSTIC: ${error instanceof Error ? error.message : 'invalid diagnostic path'}`); }
  }

  private safeOpenPath(item: DiagnosticItem): string {
    if (item.resource?.type !== 'wiki' || !item.path) throw new Error('invalid diagnostic path');
    const library = this.options.libraries.assertActive(item.resource.id);
    const files = this.options.wiki.files;
    const path = files.filePathAt(library, relative(files.bucketDir(library), item.path).replace(/\\/g, '/'));
    if (!statSync(path).isFile()) throw new Error('diagnostic path is not a file');
    return path;
  }
}
