# Core repair verification

Workspace: `electron-agent/`

- `npm run typecheck:knowledge-kernel` — PASS (`tsc -p tsconfig.knowledge-kernel.json`).
- Focused validation and contracts after the Markdown replacement-offset fix: `npx vitest run electron/agentData/knowledgeKernel/validation.test.ts electron/agentData/knowledgeKernel/contracts.test.ts` — 2 files, 21 tests PASS.
- Core matrix: `npx vitest run electron/agentData/knowledgeKernel/validation.test.ts electron/agentData/knowledgeKernel/contracts.test.ts electron/agentData/knowledgeKernel/store.test.ts electron/agentData/knowledgeKernel/coordinator.test.ts electron/agentData/knowledgeKernel/wikiPipeline.test.ts electron/agentData/knowledgeKernel/recovery.test.ts electron/agentData/knowledgeKernel/lease.test.ts electron/agentData/knowledgeKernel/completionManifest.test.ts` — Vitest resolved 7 files, 95 tests PASS. The nonexistent `recovery.test.ts` path was not included; the actual `recovery.integration.test.ts` was run separately below.
- `npx vitest run electron/agentData/knowledgeKernel/recovery.integration.test.ts` — 1 file, 1 test PASS.
- `npx vitest run electron/agentData/knowledgeKernel/coordinator.test.ts -t 'settles an interrupted stage'` — 2 v1/v2 tests PASS, no running item left and the thrown absolute-path/query payload did not reach task error details.
- The same core matrix also included the candidate-store contract and both v1/v2 invalid-link repair scenarios. A separate four-case app integration suite is owned by the integration agent; root reports 4/4 GREEN.

The report separates the actual TypeScript and Vitest checks; it is not a full repository suite or real-model run.
