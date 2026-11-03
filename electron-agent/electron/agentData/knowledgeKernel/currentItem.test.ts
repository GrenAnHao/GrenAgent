import { expect, it } from 'vitest';
import { DEFAULT_KNOWLEDGE_BUDGETS, parseKnowledgeTaskMetadata } from '../../../shared/knowledgeKernelContracts';
import { projectKnowledgeSnapshot } from './projection';
it('retains the current document through durable metadata and the shared UI snapshot', () => {
  const metadata = parseKnowledgeTaskMetadata({ version: 1, key: { projectId: 'project', portableProjectId: 'portable', workspaceInstanceId: 'workspace', branch: 'main', language: 'zh', domain: 'wiki' },
    intent: 'generate', revision: 4, phase: 'generate', currentItem: '接口与存储', pipelineConfigHash: 'pipeline', budgets: DEFAULT_KNOWLEDGE_BUDGETS,
    resumePolicy: 'auto', counts: { planned: 2, prepared: 1, failed: 0, blocked: 0, published: 0 } });
  const snapshot = projectKnowledgeSnapshot({ id: 'task', kind: 'repoWiki.generate', workspace: '/project', state: 'running', progress: 40, createdAt: 1, updatedAt: 2, metadata: { repoWiki: metadata } });
  expect(snapshot.run?.currentItem).toBe('接口与存储');
});
