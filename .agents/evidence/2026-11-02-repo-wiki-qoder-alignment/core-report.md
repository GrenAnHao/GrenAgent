# Core implementation report — Qoder alignment

## Scope and interface

- Core chain: `electron-agent/shared/knowledgeKernelContracts.ts`; `electron-agent/electron/agentData/knowledgeKernel/{executionPolicy,store,pipeline,cardPipeline,readyScheduler,coordinator,runtimeBridge,projection,completionManifest}.ts`; `electron-agent/electron/agentData/storage.ts`; `electron-agent/electron/knowledgeProcess/{host,projectPort,pipelinePrompts}.ts`; `electron-agent/electron/app/repoWikiService.ts`; `electron-agent/electron/agentDataProcess/assemble.ts` and direct tests.
- New tasks use `knowledge-kernel-qoder-v2` with frozen purpose profiles; tasks without a policy use the original budget and graph. Repair copies parent policy and pipeline; reanalysis uses new defaults. `knowledge_build_items.stage_kind` is nullable and migration 6→7 is idempotent.
- UI projection: optional `activeItems: {phase,itemId,title}[]`; `currentItem` is the first live item in graph order. v1 retains the old field. `readme` is a local phase.
- V2 catalogue model shape: `catalogue:root` and subsequent `catalogue:item:<logicalId>` expandable nodes return `{children:[{id,title,goal,dependencies,expand?:boolean}]}`. `expand:false` is a finalized leaf; otherwise a node gets its own model call; `children:[]` finishes a non-root leaf. `catalogue:complete` is a local barrier with tree, pages, requiredPageIds and catalogueHash.
- `buildCompletionManifest(requirements,checkpoints)` and `validateCompletionManifest` bind required graph-derived identities and output hashes; project port replays checkpoints and verifies the manifest again before publication and commit. Wiki and Cards use the same publication path.

## Adjacent files outside the opening source copy

- `electron-agent/electron/agentDataProcess/assemble.ts`: within the existing `knowledge.project` adapter, added the single `readReadme(projectId, sourceSnapshot, signal)` bridge; it checks an already-aborted signal and forwards `project.readReadme` with the project ID and frozen snapshot to the existing `knowledge.worker` channel. Other existing adapter and lifecycle code was not changed by this assignment.

## Adjacent process-client fix

The supplied source baseline did not include `electron-agent/vendor/repo-wiki/packages/process/src/client.ts`. Its pre-change behavior allowed `project.read` and other methods but not `project.readReadme`, and registered one active knowledge scope per taskId. The narrow repair admits `project.readReadme` and registers/checks the complete task/fence/phase/item/attempt scope, deleting only the same entry. This is necessary for the existing supervisor/worker wire path; no vendor application UI or dependency changed. The dual-child integration initially reproduced both defects; the client sibling test records RED→GREEN in `core-red-client-siblings.log` / `core-green-client-siblings.log`.

## Evidence and limits

- Full targeted core batch in `core-all-targeted.log`: 20 files, 170 tests passed before the final fixes. Final affected core set in `core-final-targeted.log`: 11 files, 114 tests passed after the client, frozen-limit, active-order, source-change and v2 incremental fixes.
- `core-typecheck.log`: final `npm run typecheck:knowledge-kernel` passed.
- `core-red-v2-update.log` / `core-green-v2-update.log` cover restoring dirty-module-only incremental reuse when baseline JSON reorders properties. `core-red-catalogue-hash.log` / `core-green-catalogue-hash.log` cover canonical catalogue identity.
- Other `core-red-*` / `core-green-*` files record policy, schema migration, store budget, host, readme, graph, scheduling, publication, revocation, execution drain, projection and repair cycles. `core-v2-policy-publication.log`: 4 v2 tests passed, including Cards and repair.
- Integration owner reported dual-child refill GREEN: three stages / two HTTP slots, ACK-before-refill, eight published pages and manifest/body/source checks. Its follow-up reports cancel with one/two slots, catalogue barrier, v1 recovery, human-edit repair, SIGKILL recovery, and dirty-module-only incremental reuse GREEN; see its separate integration logs for scope and test details.
- No paid model, real user task, restart, release, push or commit was performed.


## Final-review fixes

1. **Frozen run item limit** — `pipeline.ts` carries `maxItems` in the v2 graph, rejects an expansion as soon as cumulative catalogue definitions exceed that frozen value, and keeps v1 behavior. `coordinator.ts` passes `budgets.run.maxItems`; `projectPort.ts` receives it as `runMaxItems`, checks it against the replayed graph, and binds it into the publication intent. `wikiPipeline.test.ts` checks root and cumulative 500/501 boundaries as well as a frozen limit of 2; none of the overflow paths produce a completion barrier or page dispatch. `projectPort.test.ts` updates the v2 fixture. RED/GREEN: `core-red-max-items.log`, `core-green-max-items.log`. The focused `core-review-max-items.patch` was reconstructed by reversing only this fix in temporary copies (not a captured worktree baseline); the root owner's reconstructed review candidate is the authoritative exact comparison.
2. **Repair after validate ACK** — in v2 `coordinator.ts`, exclude `validate` from parent checkpoint copying so the local manifest is rebuilt against the repair task's snapshot ID. `coordinator.test.ts` gates publication after validate ACK, cancels, repairs, and verifies no model calls recur, the new manifest belongs to the new task, and publication succeeds. The v1 repair path and receipt recovery are untouched. RED/GREEN: `core-red-validate-repair.log`, `core-green-validate-repair.log`. `core-review-validate-repair.patch` compares the captured immediate pre-fix copies.
3. **Reserved control IDs** — v2 `pipeline.ts` uses `catalogue:item:<logicalId>` for expandable logical nodes, keeping `catalogue:root` and `catalogue:complete` as control IDs; v1 names remain unchanged. `wikiPipeline.test.ts` covers expandable logical IDs `root`, `complete`, and a nested ordinary ID; the barrier appears only after all have completed. RED/GREEN: `core-red-catalogue-namespace.log`, `core-green-catalogue-namespace.log`. `core-review-catalogue-namespace.patch` uses the captured pre-fix production file and test copy (the new RED test was removed from that copy solely to show the test addition).

Affected final regression: `core-green-review-fixes-affected.log` — 8 files, 60 tests passed; `core-typecheck-review-fixes.log` — `npm run typecheck:knowledge-kernel` passed. The integration owner is separately adapting and verifying the changed internal v2 item names.
