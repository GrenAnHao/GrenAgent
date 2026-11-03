export const REFERENCE_IDENTITY = { engine: 'qoder-wiki-local-v1', qoder: '0.5.1', context: '1.0.91.b22f2d0a', revision: 2026102902 } as const;
export const REFERENCE_PROFILE = {
  contextWindow: 150000, maxOutputTokens: 16000, maxSteps: 10, closingTurns: 1,
  maxAttempts: 2, listDirMaxTokens: 2000, maxDepth: 4,
  releaseConcurrency: { catalogue: 3, page: 3, pageUpdate: 3, pageAdd: 3 },
  debugConcurrency: { catalogue: 6, page: 6, pageUpdate: 6, pageAdd: 6 },
  retryDelayMs: { overview: 5000, plan: 5000, catalogue: 5000, page: 3000, commitAnalysis: 5000, catalogueAnalysis: 5000, pageUpdate: 2000, pageAdd: 2000 },
  minContentBytes: { overview: 200, catalogue: 300, page: 250, pageUpdate: 250 },
  git: { commitMessageMaxTokens: 500, commitDiffTotalMaxTokens: 20000, maxApplyCommits: 100, maxDropCommits: 100, maxChangedCommits: 100, maxChangedFiles: 1000 },
} as const;
