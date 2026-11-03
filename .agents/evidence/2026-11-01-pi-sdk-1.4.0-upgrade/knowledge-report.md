# Knowledge / RepoWiki SDK 1.4 verification

Result: the final current-code knowledge / RepoWiki regression group passes on official SDK 1.4.0: **34 files, 183 tests, exit 0**. No SDK compatibility fix was required in the verified knowledge code. The separate strict typecheck retains four identical baseline errors, described below.

Scope: `knowledgeModelTurn`, `ModelRuntimeHost`, `createAgentDataModelPort`, the knowledge worker and kernel, shared old Wiki / RepoWiki model scheduling, queued/running cancellation, configuration identity, real disposable OS children, restart recovery, official read-tool factories, and standalone child bundling. Tests use temporary fixture repositories/databases/configuration and loopback HTTP only. No user documents, database, credentials, paid endpoint, or running product application are used.

## Commands

Run from `electron-agent` using the already-installed local tools:

```powershell
$env:TEMP = 'C:\Users\rxstudio\AppData\Local\Temp\pi-sdk-knowledge-verify'
$env:TMP = $env:TEMP
$knowledgeFiles = @(
  'electron/agent/knowledgeModelTurn.test.ts',
  'electron/agent/modelRuntimeHost.test.ts',
  'electron/agentData/createAgentDataModelPort.test.ts',
  'electron/agentData/knowledgeCompletion.test.ts',
  'electron/agentData/runtime.knowledgeKernel.test.ts',
  'electron/agentData/runtime.repoWikiJobs.test.ts',
  'electron/agentData/wikiEngine/knowledgeModelSlot.test.ts',
  'electron/knowledgeProcess',
  'electron/agentData/knowledgeKernel',
  'electron/app/repoWikiKnowledgeModel.test.ts',
  'electron/app/repoWikiKnowledgeKernel.integration.test.ts',
  'electron/app/repoWikiWorkflow.integration.test.ts',
  'electron/app/repoWikiDurable.integration.test.ts',
  'electron/agent/repoWikiHostBuild.test.ts',
  'electron/agent/repoWikiWorkerEntry.test.ts'
)
node ./node_modules/vitest/vitest.mjs run @knowledgeFiles --reporter=verbose
# Final current-code run, same files and original per-test timeout:
node ./node_modules/vitest/vitest.mjs run @knowledgeFiles --no-file-parallelism --reporter=verbose
node ./node_modules/typescript/bin/tsc -p tsconfig.knowledge-kernel.json --noEmit --pretty false
```

The regression command needs an unsandboxed execution because it exercises local HTTP and actual disposable Node/Electron child processes. Its initial sandbox attempt ran no tests because Vite could not rename its cache in the sandbox virtual temporary directory; the isolated physical temporary directory fixes that. The minimal sandbox probe then passed six tests but could not connect to its own loopback provider. See `knowledge-baseline-env-probe.log`. No persistent environment or safety setting was changed. `pnpm exec` also failed to canonicalize the workspace path containing spaces, so the equivalent local Node entry points were used.

## 1.3.0 baseline

- Regression log: `knowledge-baseline-1.3.log`: 34 files / 180 tests, 179 passed; one actual Git snapshot test exceeded its default 5-second timeout while the whole group ran concurrently. All SDK, loopback, child, scheduling, cancellation, configuration guard, recovery, and bundle tests passed.
- Unmodified focused rerun: `knowledge-baseline-incremental-rerun-1.3.log`: 1 file / 9 tests passed; the previously timed-out Git snapshot completed in 1772ms.
- Actual direct installed versions are captured in `knowledge-installed-baseline-1.3.txt`. Electron-agent and extensions have all three SDK packages at 1.3.0. The CLI's `pi-ai` / `pi-coding-agent` are 1.3.0, while its undeclared top-level `pi-agent-core` leftover is 1.1.0. The coordinator clarified that this leftover is outside the coding-agent execution dependency graph; it is not evidence of an SDK runtime mismatch.
- Strict typecheck log: `knowledge-typecheck-baseline-1.3.log` (exit 1).
- Existing strict type errors: `stageRuntime.integration.test.ts` lines 86/88/89 access `.text` without narrowing `ImageContent | TextContent`; `TaskDetailDrawer.tsx` line 165 accesses missing `phaseLabel`. These were observed before the SDK install and are not upgrade regressions.

## 1.4.0 result

- Actual coding-agent dependency graph: all three entry points resolve `pi-coding-agent`, its `pi-ai`, and its `pi-agent-core` to official 1.4.0. Physical package paths and versions are recorded in `knowledge-installed-upgraded-1.4.txt`.
- First same-group run, `knowledge-upgraded-1.4.log`: 34 files / 182 tests, 180 passed. Real SDK loopback, official Agent tools, all OS child workflows, cancellation, scheduling, configuration guards, and bundles passed. Two failures were investigated below.
- The actual Git snapshot test reproduced its baseline parallel 5-second timeout. Unchanged focused rerun completed the Git snapshot in 2605ms.
- The mock-model token-budget test initially observed `maxTokens === 2000` where it expected `< 2000`. Concurrent user changes raised the knowledge budget and changed transcript token estimation; the fixture's hardcoded `118000` prior usage briefly no longer left only 2000 tokens. The current fixture derives prior usage from `DEFAULT_KNOWLEDGE_BUDGETS.unit.maxTotalTokens - 2000`. It and the newly added transcript-estimation case pass. Exact comparisons to the coordinator's pre-task snapshot are saved as `knowledge-concurrent-runtimeBridge.diff` and `knowledge-concurrent-runtimeBridge-test.diff`. No SDK request is involved in this mock-model test.
- Focused current-code rerun, `knowledge-upgraded-focused-rerun-1.4.log`: 2 files / 18 tests passed, covering both failed files and the new transcript-estimation regression. No source or fixture changes were made by this verification agent.
- Strict knowledge-kernel typecheck: exit 1, with the exact same four baseline errors. `knowledge-typecheck-diff.txt` records a line-by-line identical output; there are no added SDK 1.4 type errors in this configuration. This is not a claim that the existing strict configuration is green.
- Final current-code same-group run with `--no-file-parallelism`: `knowledge-final-1.4.log`: **34 files / 183 tests passed, exit 0, 163.11 seconds**. The default 5-second timeout is unchanged. The formerly timed-out Git snapshot, mock-model remaining-budget assertion, and all real SDK / OS child workflows pass in this final run.
- The final count is three tests higher than the original 180-test baseline because concurrent user edits added two cache-aware token-budget contract cases and one transcript-estimation case in the already-selected files. The selected file group was not expanded. No unrelated UI scenario or full repository suite was run by this verification agent.

## Coverage

| Requested boundary | Existing regression evidence |
| --- | --- |
| Direct official Agent, sequential tool execution, full-message `done` / `error` adaptation, retained thinking signatures and usage | `knowledgeModelTurn.test.ts`; `knowledgeProcess/stageRuntime.integration.test.ts` |
| Real SDK stream `.result()`, complete assistant/tool messages, zero automatic retries, dispatch-time header validation | `createAgentDataModelPort.test.ts`; loopback `knowledgeModelTurn.test.ts`; real ModelRuntime in the workflow/kernel integration tests |
| Shared old Wiki / RepoWiki scheduler, queued cancellation, active abort accounting, configuration refresh and shutdown drain | `knowledgeCompletion.test.ts`; `wikiEngine/knowledgeModelSlot.test.ts`; `repoWikiWorkflow.integration.test.ts` |
| Same model ID with changed real headers produces a new configuration/cache identity and rejects queued stale dispatch | `createAgentDataModelPort.test.ts`; `repoWikiWorkflow.integration.test.ts` |
| Actual disposable Electron child running official Agent + Read/Grep, forged epoch/fence rejection, reverse cancellation | `knowledgeProcess/host.integration.test.ts` |
| Two actual OS children, real ModelRuntime SDK loopback, queued and running HTTP cancellation, context/project isolation | `repoWikiWorkflow.integration.test.ts` |
| Restart resumes the same durable task from committed ACKs; dirty module incrementality; partial failure repair; pause/cancel closes real HTTP; Cards namespace | Three `repoWikiKnowledgeKernel.integration.test.ts` scenarios; `repoWikiDurable.integration.test.ts`; knowledgeKernel directory |
| Official Read/Find/Grep/Ls factories, pinned manifest and scope restrictions, truncation/line accounting | `knowledgeProcess/readTools.test.ts`; `knowledgeProcess/stageRuntime.integration.test.ts` |
| Compiled standalone child starts in both development/package layouts without node_modules and only builtin externals | `repoWikiHostBuild.test.ts`; `repoWikiWorkerEntry.test.ts`; real child integration setup |

## Changes

No production code, test fixture, dependency, lockfile, package-manager configuration, or safety setting was changed by this verification agent. Only evidence files under `.tmp-pi-sdk-1.4/` were written. Existing workflow tests also write their normal temporary reports under `.tmp-repowiki-optimization/`.
