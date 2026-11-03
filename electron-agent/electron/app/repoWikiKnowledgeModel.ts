import type { RepoWikiModelBinding } from './repoWikiService';
import { repoWikiModelCacheKey } from './repoWikiService';

export interface KnowledgeSchedulerPort {
  describeKnowledgeModel(): Promise<string>;
  completeKnowledge(input: {
    user: string; systemPrompt?: string; maxTokens?: number;
    expectedModel?: string; expectedConfiguration?: string; sourceProjectId?: string;
  }, options?: { signal?: AbortSignal }): Promise<string>;
}

/** Bind to the actual shared knowledge scheduler, never a parallel SDK route. */
export function createRepoWikiKnowledgeModelResolver(
  scheduler: KnowledgeSchedulerPort,
  configurationIdentity: () => Promise<string>,
): (workspace?: string) => Promise<RepoWikiModelBinding> {
  return async (workspace) => {
    let configuration = '';
    try {
      configuration = await configurationIdentity();
      const model = await scheduler.describeKnowledgeModel();
      const slash = model.indexOf('/');
      return {
        cacheKey: repoWikiModelCacheKey(model.slice(0, slash), model.slice(slash + 1), configuration),
        model,
        available: true,
        complete: (input, signal) => scheduler.completeKnowledge({
          ...input, expectedModel: model, expectedConfiguration: configuration, sourceProjectId: workspace,
        }, { signal }),
      };
    } catch {
      return {
        cacheKey: repoWikiModelCacheKey('', '', configuration), available: false,
        complete: async () => { throw new Error('MODEL_UNAVAILABLE'); },
      };
    }
  };
}
