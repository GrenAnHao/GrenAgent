# Task 2 report: lazy service, process scope and model leases

Implemented in `electron-agent/vendor/repo-wiki/packages/service`, `packages/process`, and `packages/contracts/src/index.ts`. No edits to core, Electron main, UI, or shared host.ts. The already approved proposed decision was read before implementation; root owns its final note transition and aggregate verify-notes run.

## Behavior delivered

- `create` awaits core `hydrate_project(root, language, name, {signal})`; clone hydrates its resulting repository. Source scanning is explicit through new action `scan({project_id,target?})` or generation. Project, changes, run and health queries use the core's cached metadata contract.
- Service scan requests coalesce by project, target, language and plan. Each caller has independent cancellation; only the last detached caller aborts the shared controller. A canceled flight is removed immediately and cleanup checks promise identity. Core separately shares its physical scan across explicit scans and generation.
- `cancelRequest` now aborts real request controllers, including a submission whose queued response was sent just before the parent timeout. Submission controllers remain registered until terminal progress so this race cannot leave generation running. Generation receives the sixth `{signal}` option and providers receive the same cancellation lifetime.
- `invokeScoped`, `registerModelLease` and `cancelContext` match the frozen signatures. Scope stays attached through IPC; the provider instance and cache identity are fixed at submit. Model calls use the registered lease rather than mutable default configuration. Progress retains originating `context_id`. Context cancellation synchronously aborts parent model controllers before awaiting the child.
- Ordinary context/model switching leaves the same physical child alive. Startup no longer validates every approved root; requested targets retain realpath and containment checks. Embedded startup does not start watchers for unrelated cached projects.
- Fixed-interval scans were removed. `fs.watch` notifications are debounced and merged. Embedded watches mark changes for explicit refresh/generation, without source scanning or automatic generation. Standalone web mode still refreshes already requested offline demo collections; it uses a scan after a filesystem notification and cached changes after debounce. Watch failures are visible and require explicit refresh. `watchInterval:0` remains a compatibility switch to disable filesystem watchers.
- CAS contract fields are validated and forwarded: page `expected_storage_token`, plan `expected_plan_storage_token`, plus returned page/project tokens. Embedded child requires tokens for edit/resolve/plan and returns 409 requesting reload if absent. Standalone service remains compatible with optional tokens.

## RED and intermediate evidence

All test stdout/stderr was redirected to files under this directory. Working directory for commands below: `D:\OneDrive\Project Files\Pi\electron-agent`.

For fixture filesystem support, every test command used:

```powershell
$env:TEMP='C:\Users\rxstudio\AppData\Local\Temp'
$env:TMP=$env:TEMP
```

Initial RED command:

```powershell
node --import tsx --test vendor/repo-wiki/packages/service/tests/lazy.test.ts vendor/repo-wiki/packages/process/tests/scopes.test.ts *> ../.tmp-repowiki-optimization/task-2-red.log
```

Result: 6 tests, 5 expected failures: missing lease/context APIs, create called old scanning path, scan action absent, context cancellation absent. One original watcher test initially passed; it was strengthened to assert zero periodic changes recomputation. Initial sandbox tmpdir produced rename EPERM; the command above was repeated with explicit writable TEMP and then failed for the intended missing behaviors.

`task-2-green-1.log`: initial 6/6 pass. `task-2-regression-1.log`: exposed an in-progress core fixture transaction bug (reported to core owner and fixed there), old timeout wording, and old tests assuming implicit scans. `task-2-regression-2.log`: 40/44 pass while explicit scan contract adaptations were completed. `task-2-regression-3.log`: 47/47 pass.

`task-2-regression-4.log`: 56/65 pass; eight localhost HTTP fixtures were blocked by sandbox EACCES, plus one watcher signature bug caused by including volatile `scanned_at`. The signature now excludes scan timestamps/state. A normal-permission fixture-only rerun was automatically approved; it passed 66/66 in `task-2-regression-5.log`.

An additional real-child regression sends `cancelRequest` with the original generation submission ID after receiving its queued response. Against the previously built child it failed to reach terminal state (`task-2-late-cancel-red.log`), proving the timeout race. After rebuilding with retained submission controllers, it passes (`task-2-late-cancel-green.log`).

## Final verification

Private child build (no running user instance is touched):

```powershell
node --import tsx --input-type=module -e "import {buildRepoWikiHost} from './electron/agent/repoWikiHostBuild.ts'; await buildRepoWikiHost(process.cwd(),'../.tmp-repowiki-optimization/task-2-child');" *> ../.tmp-repowiki-optimization/task-2-build-child-final.log
$env:REPOWIKI_TEST_ENTRY=[IO.Path]::GetFullPath('../.tmp-repowiki-optimization/task-2-child/repo-wiki-host.cjs')
node --import tsx --test vendor/repo-wiki/packages/service/tests/*.test.ts vendor/repo-wiki/packages/process/tests/*.test.ts *> ../.tmp-repowiki-optimization/task-2-regression-final.log
```

Result: **67/67 pass**, zero skipped/canceled. This includes HTTP, service, cards, process supervisor, host provider, real OS child generation/edit/conflict/export/import/watch/restart, late request cancellation, and scoped A/B model cache/progress identity with unchanged physical PID. Only local deterministic model completions and temporary repositories were used. Node emits its usual experimental SQLite warning.

```powershell
npm run typecheck:repo-wiki *> ../.tmp-repowiki-optimization/task-2-typecheck-final.log
node --import tsx --test vendor/repo-wiki/packages/process/tests/scopes.test.ts vendor/repo-wiki/packages/service/tests/lazy.test.ts *> ../.tmp-repowiki-optimization/task-2-contract-final.log
```

Result: typecheck exit 0; final focused contract/service checks **9/9 pass** after the wire scope validator cleanup. `task-2-scoped-child-final.log` separately records the new real child late-cancel and scoped-model tests **2/2 pass**.

## Boundaries and remaining integration ownership

No real registered project was scanned/migrated, no user SQLite/cache was deleted, no provider was charged, no application was restarted, and no commit/push occurred. Fixture cleanup only removed directories allocated by each test. Heavy scanner responsiveness and timeout/retry pressure are additionally covered by task 5, which builds its own current child. Root owns final aggregate build/UI/notes gates and the final implementation note.

## Final production migration responsiveness follow-up

Root requested removal of the remaining synchronous legacy snapshot from the isolated service IPC thread. Core owner supplied `WorkspaceEngineOptions.snapshotLegacy(from,to,signal):Promise<MigrationResult>` while preserving the existing audited `migrateWorkspace` algorithm and the direct standalone fallback.

Added `packages/process/src/legacy-snapshot.ts`. The normal child injects `snapshotLegacyInWorker` through the new optional service `engineOptions`; an explicitly injected service engine retains precedence. The worker runs the existing bundled `repo-wiki-host.cjs` entry with private `workerData.kind='legacy-snapshot'`. The entry recognizes worker mode before checking `process.send` or constructing a service, so no new packaging resource is required. No migration algorithm or safety verification was replaced.

Worker completion waits for actual thread exit. Cancellation awaits `worker.terminate()` before rejecting into core's cleanup, and unmanaged file descriptor tracking is explicit. The service also tracks active dispatch requests: shutdown aborts and awaits hydration before closing the engine. This preserves the ordering worker termination → core snapshot directory cleanup → engine close → process exit.

New real bundled-child fixture creates approximately 50 MiB of legacy page data entirely in a private temp directory, including large pages belonging to an unrelated fixture project. The test waits for the migration algorithm's actual `.repowiki-migration-` staging directory before requesting health and cancellation. It asserts health finishes before hydration, cancellation publishes no project documents, all snapshot temp directories disappear, the original DB hash stays unchanged, no model is called, the same child successfully retries and restores the small current-project page, and no unrelated project directory is created. A second fresh fixture child tests graceful stop during a new snapshot and requires zero staging directories after exit. There is no test-only product delay switch.

Evidence:

- `task-2-migration-worker-red.log`: previous bundle fails because health only finishes after synchronous hydration.
- `task-2-migration-worker-copy-green.log`: actual copy-stage cancellation and retry pass with the worker.
- `task-2-migration-shutdown-red.log`: previous worker bundle leaves a `repowiki-legacy-copy-*` directory when stopped during hydration.
- `task-2-migration-shutdown-green.log`: current child plus related service tests **24/24 pass**, using the actual Electron-as-Node executable.
- `task-2-migration-worker-typecheck.log`: repo-wiki typecheck exits 0.
- `task-2-migration-regression-final.log`: final aggregate service/process run **68/68 pass**, zero skipped/canceled, with the real Electron-as-Node child; supersedes the earlier 67-test run and includes the migration worker fixture.

The final follow-up commands use the same explicit TEMP/TMP and private bundled child build shown above, plus:

```powershell
$env:REPOWIKI_TEST_EXECUTABLE=node -p "require('electron')"
node --import tsx --test vendor/repo-wiki/packages/service/tests/*.test.ts vendor/repo-wiki/packages/process/tests/*.test.ts *> ../.tmp-repowiki-optimization/task-2-migration-regression-final.log
npm run typecheck:repo-wiki *> ../.tmp-repowiki-optimization/task-2-migration-worker-typecheck.log
```

## Windows case-insensitive output watch exclusion

Final review identified that a project with an existing `Docs/` directory can report generated files through native `fs.watch` as `Docs/repo-wiki/...`. The service's literal lowercase guard treated these as source changes. `task-2-windows-watch-red.log` records a real Windows filesystem notification reproducing the defect: generating a fixture Markdown document incorrectly changed `watching` to `needs_generation`.

The service now imports the shared scanner `isKnowledgeOutput(relative)` helper rather than duplicating its path comparison. Core owner normalizes separators and applies Windows case folding in that helper, keeping source enumeration, hashing/deletions, source reads and watch notifications consistent; POSIX remains case-sensitive. A real Windows native-watch probe also showed `change Docs` ancestor-directory mtime events after writing the excluded descendant. Recursive watcher directory `change` duplicates are now ignored after a single directory stat; actual file events and directory rename/add/remove events remain active. This avoids treating an excluded wiki write as a source change through its parent directory.

The new service regression exercises both embedded and standalone watch modes: writing a generated document and then externally editing it produce zero changes recomputation/scan and keep `watching`; writing ordinary `Docs/guide.md` still triggers the corresponding source notification/scan.

```powershell
$env:TEMP='C:\Users\rxstudio\AppData\Local\Temp'
$env:TMP=$env:TEMP
node --import tsx --test vendor/repo-wiki/packages/service/tests/lazy.test.ts vendor/repo-wiki/packages/service/tests/service.test.ts *> ../.tmp-repowiki-optimization/task-2-windows-watch-green.log
npm run typecheck:repo-wiki *> ../.tmp-repowiki-optimization/task-2-windows-watch-typecheck.log
```

Latest result: **24/24 affected service/watch tests pass**, zero skipped/canceled; typecheck exits 0. The unrelated 68-test service/process aggregate was not rerun for this focused watch correction.

The legacy migration fixture's assertion now checks `portable_id === 'current'`, consistent with core's final workspace-scoped runtime ID contract; all subsequent calls continue using the returned runtime `id`.

## Permission errors at the service boundary

Root's final acceptance check found that an initial `mkdirSync` failure can escape ProjectFiles' internal save translator. Only `service.safeError` changed: raw filesystem `EACCES`, `EPERM`, and `EROFS` now return status 403 with an explicit project-folder permissions/read-only message. Raw paths, provider keys and original exception details remain withheld; authored contract/core errors keep their existing translation.

`task-2-permission-red.log` records the expected initial 500-versus-403 failure. The new test injects each of the three filesystem errors into the real core hydration's first docs-directory creation, then verifies the create request rejects, the translated message is useful and sanitized, no facts directory exists, and the public project cache remains empty. It changes no real ACL or security setting. The original mkdir function is restored after each fixture attempt.

```powershell
node --import tsx --test --test-name-pattern='create permission failures|authored scanner validation' vendor/repo-wiki/packages/service/tests/service.test.ts *> ../.tmp-repowiki-optimization/task-2-permission-green.log
npm run typecheck:repo-wiki *> ../.tmp-repowiki-optimization/task-2-permission-typecheck.log
```

Latest result: **2/2 focused tests pass**, including all three permission codes and the existing safe-error redaction boundary; typecheck exits 0. No unrelated aggregate tests were rerun.
