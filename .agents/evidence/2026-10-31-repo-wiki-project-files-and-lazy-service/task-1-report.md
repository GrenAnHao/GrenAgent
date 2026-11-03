# Task 1 report — project files and asynchronous scanning

Scope: core engine/scanner/project-files and core tests only. No service/process/main/UI edits, commits, pushes, paid providers, app restarts, user database reads, or real-project migrations. All filesystem deletion and fault injection used mkdtemp fixtures. Existing dirty host DTO/WorkspaceService changes were preserved.

## Result and interfaces

- Facts now live under `<workspace>/docs/repo-wiki/<language>/`: project.json, plan.json, migration.json when applicable, and namespace.json + Markdown/pages + JSON/meta. Metadata retains generated baseline, pending proposal/sources, archive status, source references, revision, and all other page fields. Portable disk IDs remain unchanged; public/cache project IDs are deterministically scoped to canonical workspace + language + portable ID. Windows device names, uppercase/case-distinct IDs, and escape prefixes use injective safe filenames. All branch/language/wiki/cards namespaces are retained during migration.
- New disposable cache: `<dataDir>/project-index.sqlite3` and its SQLite sidecars. Old `<legacyDataDir>/workspace.sqlite3` is not opened for writes; migration reuses existing copy-first, source-byte-verified offline snapshot logic and only exports matching current root/language from the copy. `legacyDataDir` is optional and defaults to constructor dataDir. The old source remains intact.
- Constructor stays `new WorkspaceEngine(dataDir, options?)`. Options include `databaseFactory?`, `legacyDataDir?`, and `snapshotLegacy?: (from:string,to:string,signal?:AbortSignal)=>Promise<MigrationResult>`. MigrationResult is type-reexported by engine.ts. `await hydrate_project(path, language='zh', name?, {signal}={})` returns a Project directly. Hydration never invokes Git, source enumeration, or a provider. New projects use a small default plan or safely import root wiki_plan.json once; subsequent updates use the project plan.json.
- `get_project`, `list_projects`, and `changes` read cached project metadata/results. `changes` returns `scan_state:'unknown'|'ready'` and `scanned_at`; it never initiates scanning. `await scan_project(id,{target?,signal?}={})` performs explicit asynchronous filesystem/Git scanning. Shared scan flights reference-count callers and abort the physical scan only after the final consumer leaves. Generation accepts sixth `{signal}` and scans asynchronously before generation and before commit.
- `WikiPage.storage_token` covers the complete logical page record. `Project.plan_storage_token` hashes the validated plan. Core signatures are `edit_page(..., expected_revision, expected_storage_token?)`, `resolve_page(...)` likewise, and `update_plan(id,input,expected_plan_storage_token?)`. Optional core arguments preserve direct API compatibility; embedded service/UI owners enforce and propagate the required wire tokens.
- Writes refresh facts before CAS; external Markdown edits allocate newer numeric revisions using the persisted cross-namespace counter. External plan changes invalidate the plan token and generation commit. Single-file source links read a bounded safe current file after restart, without scanning the repository.

## File transactions and recovery

ProjectFiles serializes application instances using an exclusive ownership file, stages complete change sets, fsyncs staged files and independent before images, validates the read set, then publishes files through rename. A prepared journal resumes idempotently after interruption. Unknown external hashes stop recovery, retain both current text and before images, and block cached project/page/list reads rather than presenting a mixed successful result. An initialization receipt allows retry after an initial write fails before preparation. A failed lock-owner write releases its descriptor/reservation; only a still-empty directory created by that operation is removed.

SQLite remains a materialized projection and generation cache. Hydration rebuilds it from facts; each mutation first publishes project files and then commits the projection. Removing the fixture cache and reopening preserves IDs, text, baseline, revisions and plan. SQLite is not used to overwrite project files on ordinary reads.

## Tests and observed evidence

All test stdout/stderr is retained under `.tmp-repowiki-optimization/`. Commands below run from `electron-agent`.

| Evidence | Command/result |
| --- | --- |
| `task-1-red.log` | `node --import tsx --test vendor/repo-wiki/packages/core/tests/project-files.test.ts`: initial six tests fail because hydrate/async scanner are absent |
| `task-1-red-paths.log` | Windows device/case-distinct IDs fail before filename encoding; external plan token/cancel case already passes |
| `task-1-red-init-retry.log` | Initial fsync failure is reported, but a later hydration initially cannot resume; initialization receipt fixes it |
| `task-1-red-source.log` | Reopened source link initially fails without an in-memory scan; bounded single-file path fixes it |
| `task-1-red-receipt-proto.log` | Migration receipt missing and `__proto__` record lost before receipt/null-prototype maps fixes |
| `task-1-red-lock.log` | Initial lock ownership write leaks a reservation before the try/finally/empty-reservation fix |
| `task-1-recovery-1.log` | Legacy namespace without snapshot + prepared recovery + unknown external conflict: 3/3 PASS |
| `task-1-files-green-4.log` | File facts/initial recovery/path/cancel cases at that checkpoint: 11/11 PASS |
| `task-1-core-regression-2.log` | First normal-permission old core regression: 69/81 PASS; failures reflect old implicit-scan/auto-old-DB contracts, factory path, and one missing legacy namespace fallback |
| `task-1-core-regression-3.log` | Updated explicit scan/hydrate tests: 82/83 PASS; the remaining old DB without snapshot case is subsequently fixed |
| `task-1-core-final.log` | All seven core test files: 143/143 PASS, 0 fail/cancel/skip |
| `task-1-core-final-2.log` | Final all-seven-core command after formatting, lock retry, and source boundary self-review: **144/144 PASS**, 0 fail/cancel/skip, 33.93s |
| `task-1-typecheck-final-2.log` | `npm run typecheck:repo-wiki`: exit 0, no diagnostics |
| `task-1-red-snapshot-hook.log` | Injected async snapshot is not called and cancellation follows the old sync path: 2/2 FAIL before the new option/await |
| `task-1-green-snapshot-hook.log` | After injection/await: all affected project-file/hydration tests **15/15 PASS**, 0 fail/cancel/skip, 5.46s |
| `task-1-typecheck-snapshot-hook.log` | Latest `npm run typecheck:repo-wiki` after the snapshot hook: exit 0, no diagnostics |
| `task-1-red-clone-case.log` | Two-root copied portable-ID collision and Windows case-preserved output self-feeding: 2/2 FAIL before fixes |
| `task-1-green-clone-case.log` | Both clone/runtime isolation and platform-correct output exclusion: 2/2 PASS |
| `task-1-red-export-cache.log` | Explicit export uses stale text, cache COMMIT lacks truthful recovery error, corrupt generation-cache JSON throws: 3/3 FAIL before fixes |
| `task-1-clone-core-regression.log` | Affected file/engine/cards/migration/scanner tests after those fixes: 95/95 PASS |
| `task-1-red-scoped-transaction-cache-error.log` | Editing A incorrectly reloads unavailable B; corrupt derived DB lacks clear fact-preservation error: 2/2 FAIL before fixes |
| `task-1-clone-core-final.log` | Scoped transaction/cache failure changes: 97/97 affected tests PASS |
| `task-1-red-portable-change.log` | An old runtime request can overwrite a newly checked-out portable project identity: 1/1 FAIL before identity guard |
| `task-1-identity-core-final.log` | Final affected five-file suite after all identity/cache/export guards: **98/98 PASS**, 0 fail/cancel/skip, 35.18s |
| `task-1-typecheck-identity-final.log` | Final strict Repo Wiki typecheck: exit 0, no diagnostics |

Final core command:

```text
node --import tsx --test vendor/repo-wiki/packages/core/tests/project-files.test.ts vendor/repo-wiki/packages/core/tests/engine.test.ts vendor/repo-wiki/packages/core/tests/cards.test.ts vendor/repo-wiki/packages/core/tests/scanner.test.ts vendor/repo-wiki/packages/core/tests/migration.test.ts vendor/repo-wiki/packages/core/tests/providers.test.ts vendor/repo-wiki/packages/core/tests/git-auth.test.ts
```

The 14 new file/scanning tests cover explicit cheap hydration and cached changes, deleting/rebuilding the fixture cache, external Markdown/stale numeric CAS, unknown destinations, current-root lossless/idempotent migration and source bytes, output exclusion and cancellation, Windows names/case distinction, external plan token and mid-traversal cancellation, prepared recovery/before images, blocked external recovery conflict, failed initial fsync/retry, reopened source links, prototype-like IDs, and failed lock ownership write/retry.

Old tests were updated only to reflect the new boundaries: callers explicitly await scan_project after source edits and Git checkout; old DB fixtures explicitly await current-project hydration; factory expects the new cache filename; equality checks separate newly added storage_token from legacy page content. Original source dependency, merge/conflict, archive, branch/language/cards, provider, clone, WAL recovery, cancellation, and safe path assertions remain.

Default Windows AppContainer runs cannot create some existing symlink/hard-link/Git fixtures; the sandbox logs are retained as `task-1-green-initial.log`, `task-1-green-2.log`, and `task-1-core-regression-1.log`. Normal-permission runs were automatically approved for isolated fixtures and provide the final results. No test was skipped to hide those failures.

## Rulings and remaining engineering boundaries

- The cache keeps a SQL projection to preserve existing engine query behavior, but files are hydrated before use and refreshed before mutation; writes never rely on SQLite as the only saved copy. This is smaller than rewriting every engine algorithm to a second in-memory data model.
- Hydration without Git uses persisted identity/active namespace. Older records lacking a snapshot keep an explicit migrated namespace until the next explicit scan discovers the actual branch. Unknown scan state is not presented as a fresh source check.
- The existing offline migration algorithm stays unchanged and bounded to 512MiB. Core now awaits an injected snapshotLegacy worker port, including its cancellation/exit, before opening the copy or executing finally cleanup. Embedded production supplies a terminable worker using the same host bundle; that adapter and real-child cancellation evidence are owned by the process task. Only direct/standalone callers without the injection retain the synchronous compatibility fallback. Core's new cancellation test verifies that temporary files still exist until the injected worker acknowledges exit and are removed only after its promise settles; it does not substitute for the process owner's real Worker test.
- Application locks and journal recovery do not provide a kernel-level compare-and-swap against arbitrary external editors, nor one-rename visibility for an arbitrary external reader of multiple files. Content tokens, close-to-publish rechecks, independent before images, and blocked recovery preserve recoverable data at the supported boundary. This matches the design report's explicit limit; strict native Windows conditional replacement would be a separate mechanism.
- A corrupt `project-index.sqlite3` is not automatically quarantined or deleted. Constructor failure closes its handle and clearly reports that project files are unchanged and the disposable cache can be rebuilt. The fixture verifies untouched facts and successful manual new-cache deletion/hydration. A malformed JSON/invalid output row in generation_cache is a miss. If facts have published and SQL COMMIT then fails, the error explicitly says the files were saved and advises re-read/rebuild; rollback affects only SQL, and fixture re-read plus cache deletion/hydration recover the newly saved text. This bounded behavior follows the root's final scope ruling, rather than the earlier design recommendation for broad automatic cache repair.
- No full application UI/build or all-repository test claim is made here; those are coordinated by the root/task-5 owners. Only the Repo Wiki core suite and strict Repo Wiki typecheck are the evidence for this task.

## Snapshot cancellation follow-up

Root review required real cancellation during old-DB copy instead of merely checking AbortSignal before/after synchronous migration. The minimal core change adds snapshotLegacy to WorkspaceEngineOptions, stores it on the engine, and awaits it in hydrate's existing try/finally. The documented port contract requires settlement only after actual worker termination/exit, so fixture/temp cleanup cannot race a worker still using the directory. There is no Promise.resolve wrapper around the production synchronous path; the process owner supplies the Worker implementation.

RED observed: the injected successful copy counter remained zero, while the canceled fixture hit the old migration error rather than the worker's cancellation. GREEN observed: the real copy-first fixture runs through the injected async port once and stays idempotent; cancellation reaches the port, leaves the fixture's original DB bytes intact, waits for its delayed exit, removes only the owned temporary directory, and creates no project facts. Only the 15 affected file/hydration tests and strict Repo Wiki typecheck were rerun for this follow-up, as requested.

## Final review follow-up: clone and portable identity isolation

The initial file implementation still used portable project.json.id as a global SQL/files-map key. A fixture copies the complete facts into a second root, hydrates both, and observes the original collision before the fix. The final public/cache ID is the first 24 SHA256 hex characters of `["repo-wiki-runtime-project-v1", canonicalWorkspaceKey, language, portableId]`; the returned Project includes portable_id. Canonical workspace keys normalize Windows path prefixes/slashes/case. ProjectFiles converts the cache model back to the original portable id when writing project.json and never persists the runtime id as the portable id. A version marker in the new cache clears obsolete project/page/snapshot/revision projections once; it keeps generation_cache and does not migrate or change fact files or the original DB.

The two-root fixture independently edits A/B pages and B's plan, verifies both entries remain visible, deletes only the temporary new cache, hydrates in reverse B-A order, performs A-B-A switching, and checks identical public IDs are rebuilt and both disk ids remain the copied portable value. Old migration assertions now use the hydrated public ID for API calls and portable_id for the preserved legacy identity. No alias based only on bare portable id is allowed, because it would reintroduce clone ambiguity.

An additional real filesystem identity-change fixture rewrites project.json.id in the same root, simulating checked-out/restored portable facts. Before the guard an old runtime edit overwrites the new identity. refreshProject now rejects a different loaded portable id with 409 before any cache import or write. Hydrate checks just the small identity manifest, retires the old runtime cache/files/scan mapping, and binds the new deterministic ID. The old ID becomes unavailable; the checked-out identity and Markdown remain intact. Transactions now refresh only their current project, so a previously hydrated but unavailable clone cannot cause an unrelated A edit to access B.

The shared isKnowledgeOutput helper normalizes path separators and folds case on Windows, so existing `Docs/Repo-Wiki` physically aliases the excluded fact directory correctly. POSIX deliberately remains case-sensitive; its test expectations follow that semantic without skipped tests. The process owner reuses the helper for real watcher filtering. Explicit Markdown export refreshes current fact files without changing the cached source-scan timestamp; cheap project/status remain cached.

Final production source was frozen after `task-1-identity-core-final.log` (98/98 affected tests) and `task-1-typecheck-identity-final.log` (exit 0). The provider/git-auth suites were unchanged by this final review delta and were last included in the earlier 144/144 complete-core run. Root/task-5 own the final rebuilt real-child/SDK and UI source-fingerprint verification.
