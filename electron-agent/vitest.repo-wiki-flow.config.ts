import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', maxWorkers: 2, include: [
  'electron/app/repoWikiFlow.integration.test.ts',
  'electron/wikiService/nativeWorkflow.integration.test.ts',
  'electron/app/nativeWikiController.test.ts',
  'electron/app/nativeWikiModel.test.ts',
  'electron/agentData/nativeWikiProjection.test.ts',
  'electron/wikiService/host.test.ts',
  'electron/wikiService/service.test.ts',
  'electron/wikiService/store.test.ts',
  'electron/wikiService/repository.test.ts',
], testTimeout: 60000, hookTimeout: 30000 } });
