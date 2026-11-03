# Task 1/2 RED evidence

These observations were recorded before the corresponding implementations in this agent session on 2026-11-01 (local time).

- 17:15:03 contracts.test.ts: module knowledgeKernelContracts did not exist; Vitest failed suite import (1 failed file).
- 17:16:45 store.test.ts and lease.test.ts: module store did not exist; Vitest failed imports (2 failed files).
- 17:18:15 store tests: paused removal did not throw JOB_ACTIVE; generic JobStore protection was added afterward. A fixture used fractional read bytes and was corrected to integer bytes (not a product failure).
- 17:19:18 copyRepairArtifact was not a function; repair copy/list/remaining interfaces were added afterward.
- 17:20:26 failed-item retry raised ITEM_COMMIT_CONFLICT and modelRequests counted 2 instead of 1; clearing prior attempt output/counters and deriving request counts from persisted kind fixed both.
- 17:22:10 duplicate original receipt after scope handoff raised PUBLICATION_RECEIPT_MISMATCH; persistent settlement audit was added afterward.
- 17:22:56 blockPublication was not a function; pinned block/reconciler release interfaces were added afterward.

Initial sandbox execution hit Vite EPERM rename before tests; the same local commands were rerun with escalation. This is an environment issue and is not counted as a product RED assertion.

GREEN output: task-1-2-green.log. Strict compiler: task-1-typecheck.log.

Additional RED: 17:24:56 renewLease missing; 17:28:32 detached HEAD rejected by branch schema; 17:38:19 requestControl missing (3 cases). Corresponding targeted runs passed after implementation.

Additional RED: 17:41:03 readPublicationClaim missing for previous-controller pinned recovery; 17:42:07 maxItems=1 incorrectly rejected plan after prepare. Focused store/lease suite passed after both corrections.
