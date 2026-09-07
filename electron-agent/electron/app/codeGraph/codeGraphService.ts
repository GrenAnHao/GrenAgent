import { CodeGraphEngine, type CodeGraphEngineOptions } from './codeGraphEngine';
import { probeProjects, type ProjectIndexState } from './indexProbe';
import type { CodeRetrievalRow } from '../../agentData/codeRetrievalResult';

export type { CodeGraphStatusView } from './codeGraphEngine';
export type CodeSearchHit = CodeRetrievalRow & { file: string };
export interface CodeSearchView { workspace: string; available: boolean; results: CodeSearchHit[]; message?: string }
export interface CodeGraphServiceOptions extends CodeGraphEngineOptions { listWorkspaces: () => string[] }

/** Existing AgentData entry points backed by one embedded SDK engine. */
export class CodeGraphService extends CodeGraphEngine {
  constructor(private readonly config: CodeGraphServiceOptions) { super(config); }

  projects(): ProjectIndexState[] { return probeProjects(this.config.listWorkspaces()); }

  async search(workspace: string, query: string, limit: number): Promise<CodeSearchView> {
    try {
      const response = await this.call(workspace, 'codegraph_search', { query, limit });
      return {
        workspace, available: !response.isError,
        results: response.structuredContent.rows.filter((row): row is CodeSearchHit => typeof row.file === 'string'),
        ...(response.isError ? { message: response.content.map(({ text }) => text).join('\n') } : {}),
      };
    } catch (error) {
      return { workspace, available: false, results: [], message: error instanceof Error ? error.message : String(error) };
    }
  }
}
