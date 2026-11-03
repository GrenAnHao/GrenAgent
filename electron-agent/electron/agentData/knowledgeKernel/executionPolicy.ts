import { DEFAULT_KNOWLEDGE_BUDGETS, knowledgeExecutionPolicySchema, type KnowledgeBudgets, type KnowledgeExecutionPolicyV2, type KnowledgeStageKind, type KnowledgeTaskMetadata } from '../../../shared/knowledgeKernelContracts';

const unit = (maxModelRequests: number, maxToolCalls: number, maxTotalTokens: number, maxReadBytes: number, activeTimeMs: number): KnowledgeBudgets['unit'] => ({ ...DEFAULT_KNOWLEDGE_BUDGETS.unit, maxModelRequests, maxToolCalls, maxTotalTokens, maxReadBytes, activeTimeMs });
export const DEFAULT_KNOWLEDGE_EXECUTION_POLICY: KnowledgeExecutionPolicyV2 = {
  version: 2, catalogueConcurrency: 3, pageConcurrency: 3, maxCatalogueNodes: 64,
  profiles: {
    overview: unit(12, 40, 200000, 2097152, 600000),
    plan: unit(6, 16, 120000, 1048576, 300000),
    catalogue: unit(8, 24, 160000, 1048576, 300000),
    page: unit(20, 60, 300000, 2097152, 600000),
    'module-card': unit(20, 60, 300000, 2097152, 600000),
    'repository-card': unit(12, 32, 200000, 2097152, 600000),
    relations: unit(8, 24, 160000, 1048576, 300000),
  },
};
export function resolveKnowledgeUnitBudget(metadata: Pick<KnowledgeTaskMetadata, 'budgets' | 'executionPolicy'>, stageKind?: KnowledgeStageKind): KnowledgeBudgets['unit'] {
  if (!metadata.executionPolicy) return metadata.budgets.unit;
  const policy = knowledgeExecutionPolicySchema.parse(metadata.executionPolicy) as KnowledgeExecutionPolicyV2;
  if (!stageKind || !Object.hasOwn(policy.profiles, stageKind)) throw new Error('STAGE_KIND_REQUIRED');
  return policy.profiles[stageKind];
}
