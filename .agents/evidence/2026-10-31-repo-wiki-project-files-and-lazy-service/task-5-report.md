# Task 5: Repo Wiki real integration acceptance

Result: PASS for the assigned integration scope. Latest run, freshly rebuilt after the final clone/public-ID, portable-identity, case/export/cache-boundary guards, migration Worker/close lifecycle, watcher, and host `view_id` freezes: **3 files, 12 tests passed**, exit 0, 6.90 seconds. No paid provider, real user database/project migration, running-app restart, commit, or push was performed.

## Changed files

- `electron-agent/electron/app/repoWikiLazy.integration.test.ts` (new): seven registered projects with seven populated legacy records; cold activation; current-root-only hydration/migration; metadata reads; real scan cancellation/timeout responsiveness; real child index deletion/rebuild; preserved legacy portable/disk IDs with stable distinct runtime/cache IDs; exact source hashes for the benchmark JSON files.
- `electron-agent/electron/app/repoWikiHostProjects.integration.test.ts`: explicit lazy hydration, language DTO, scratch/registration/revocation/crash/retry coverage, stable child PID, explicit scan semantics.
- `electron-agent/electron/app/repoWikiWorkflow.integration.test.ts`: new host snapshot/hydrate handshake; stable PID and close/cancel/late-event assertions while retaining the real SDK/shared knowledge queue/configuration guards.
- Existing workflow fixture and AgentData child fixture were reused without modification. Product files were not edited by this task.

## Reproduction and logs

From `electron-agent`:

```powershell
$env:TEMP = 'C:\Users\rxstudio\AppData\Local\Temp\Pi-repowiki-integration'
$env:TMP = $env:TEMP
npx vitest run electron/app/repoWikiLazy.integration.test.ts electron/app/repoWikiHostProjects.integration.test.ts electron/app/repoWikiWorkflow.integration.test.ts
```

Latest full command stdout/stderr: `task-5-integration-identity-final.log`. Earlier results remain in `task-5-integration-worker-final.log`, `task-5-integration-latest.log`, `task-5-integration-final.log`, `task-5-integration-first.log`, `task-5-integration-second.log`, `task-5-lazy-scan-timeout.log`, and `task-5-integration-green.log`.

- First integrated run: 2 passed / 9 failed. Real child hydration exposed `Incomplete knowledge transaction`; storage owner fixed the journal digest. An integration helper incorrectly sent a context token to `hostProjects`; this test helper was fixed.
- Second integrated run: 10 passed / 2 failed. One health assertion still expected eagerly resolved model availability and was updated to the intentional lazy model-preparation contract. Registration refresh produced duplicate notices; host owner fixed deduplication. The exact-one assertion was retained.
- Full green before the final seeded legacy extension: 12/12 passed.
- Final run with all seven legacy project rows and human-edited pages: 12/12 passed.
- Latest rebuilt child after task 2's final late-cancellation lifecycle fix: 12/12 passed.
- Final rebuilt child after production `snapshotLegacy` Worker, terminating-worker cleanup/awaited close, and host `view_id` changes: 12/12 passed.
- Latest rebuilt child after the final clone/cache-identity and portable-ID guard changes: 12/12 passed. Tests intentionally check `portable_id` and disk ID preservation rather than requiring the public/cache ID to equal a legacy global ID.
- Initial preimplementation RED attempts were blocked by sandbox temp rename/realpath restrictions and a concurrent host-file replacement; they are **not behavioral RED evidence**. Host owner independently ran `repoWikiLazyHost.test.ts` on the old implementation and observed eager `allowedWorkspaces` access / missing snapshot API; refer to task 3's RED evidence. The first real integrated failure above is task 5's own observed failure evidence.
- Tests required the authorized unsandboxed fixture execution because Windows sandbox `fs.realpath` rejected newly created temp fixture paths. No automatic approval rejection remains. SQLite experimental warnings are present; there are no failed tests in the final run.

## Verified behavior

| Boundary | Evidence / outcome |
| --- | --- |
| Seven-project activation | Seven real WorkspaceService registrations plus seven legacy SQLite project/page rows; returns `bound` from the in-memory snapshot with authority reads 0, model resolutions 0, no child PID, no new index, no project document writes, and unchanged legacy DB bytes. |
| Current-root hydration | Real child invokes the production `engineOptions.snapshotLegacy` hook and the same bundled entry in a Worker; only portable `legacy-1` is published. The 24-hex public/cache ID is distinct, while `project.portable_id` and disk `project.json.id` remain `legacy-1`. Invalid source plans in the other six roots do not affect it; the other six `docs/repo-wiki` directories remain absent; old SQLite bytes remain identical. No migration hook or Worker was stubbed. |
| Metadata-only reads | Project/changes/run/projects/health still work with an invalid current source plan, no model resolution, same PID; unauthorized sender and stale hydrate token reject. |
| Real scan responsiveness | 1,000 fixture TypeScript files of 98,331 bytes each. Health/run answered in **11.427 ms** while the returned run stage was `scanning`. Cancel reached terminal `canceled`, with **zero completion callbacks** and no generated page. |
| Timeout cancellation | Explicit scan with a 1 ms request timeout rejected 504; health remained responsive and the timed-out scan did not publish `current_identity`. A new scan completed in **1,096.168 ms**, with no model dispatch. |
| Disposable index | First real OS child generated and edited Markdown; after stopping it, only fixture `project-index.sqlite3` and its WAL/SHM suffixes were removed. A second real child rehydrated the same public/cache ID, portable ID, Markdown, baseline, sources, edited status, and revision from project files. The disk ID equals the preserved portable ID. |
| Host authority/lifecycle | Seven host integration cases passed: exhausted supervisor explicit retry, namespace changes, scratch empty state, crash token rotation, explicit scan/A-B-A preservation, collection vs hydration separation, registration/revocation and exactly one notice. |
| Production dual-child workflow | Parent PID 62488, AgentData PID 10768 (Electron Node 22.22.0), RepoWiki PID 70692. Real WorkspaceService, RepoWiki child, AgentDataService child, WikiService, model port, ModelRuntimeHost, Pi SDK, and HTTP loopback provider. |
| Shared budget and cancellation | Legacy Wiki ingest occupies global concurrency 1; queued Repo Wiki cancellation never reaches provider. Running cancel closes actual SDK HTTP connection. A-B-A and panel close retire old context/model work while retaining the same RepoWiki PID and Markdown. Stale/cross-project calls and old progress are rejected. |
| Model/configuration protection | Knowledge model differs from app default; queued stale model binding rejects before dispatch. Changing real SDK headers with the same model ID changes cache identity; old queued configuration rejects and new binding sends the changed header. |

## Timing boundary

`cold-activation-sample.json` records the latest fresh-service API activation: **7.576 ms**, Windows, test-runner Node v25.5.0, seven local temp projects, seven seeded legacy records, primed in-memory host registry. Service construction and fixture/build setup precede the measured interval. The operation starts no Wiki child and performs no model resolution or authority I/O.

The previous **33.48 s** observation came from the user's real seven-project activation with different source/database/cache state. This fixture result demonstrates the removed blocking work; it is **not a matched statistical benchmark**, a renderer-paint measurement, or a direct retest of the user's OneDrive projects. UI first-paint measurement belongs to task 4.

## Latest source boundary

Core/process owners and the coordinator declared the final identity, clone/case/export/cache-boundary, watcher, Worker, and service-close product sources frozen before this latest run. `buildRepoWikiHost` compiled a new `repo-wiki-host.cjs` for these tests. The legacy fixture exercised its real Worker migration entry and new runtime-vs-portable identity boundary; the actual HTTP SDK/AgentData workflow used the same current production host build.

`task-5-source-snapshot.json` records SHA-256 for every esbuild child input plus the production main-process RepoWiki service, WorkspaceService registry, and host DTO. Its aggregate identity is `694c72cb01ed81c40bd46f72882346582b9f9c5459a236939adcc855b28cf775`, built at `2026-10-31T13:18:43.484Z`. Both benchmark JSON files carry this same identity. This includes clone/case/export/cache-boundary guards, the `view_id` host implementation, and new Worker/close code. Specific clone/case/export and same-path-remount behavior remains covered by the core/host/UI owners' focused tests; these twelve integration cases exercise the updated public/cache/portable ID contract and existing end-to-end paths.

The process owner's separate approximately 50 MiB migration-copy health/cancel/retry and stop-during-migration cleanup matrix is complementary evidence. This task's final run covers actual production Worker invocation with the populated seven-project legacy fixture and retains the real SDK regression chain; the source-scan timing measures source scanning rather than migration copying.

## Preserved file/process evidence

- `cold-activation-sample.json`
- `scan-responsiveness-sample.json`
- `task-5-source-snapshot.json`: exact bundled-input/main-host source hashes referenced by both timing samples.
- `workflow-integration.log` and `workflow-integration-report.md`: full real process/RPC/provider trace and eight workflow acceptance checks.
- `task-5-current-root-migration/migration-evidence.json`: seven seeded legacy projects, selected legacy project, unchanged legacy SHA-256, and six untouched root paths.
- `task-5-current-root-migration/repo-wiki/zh/`: actual migrated project metadata, plan, namespace, page metadata, and human legacy Markdown copied before fixture cleanup.
- `task-5-index-rebuild/rebuild-evidence.json`: first/restored child PIDs, exact deleted fixture cache path, complete original/edited/restored page records.
- `task-5-index-rebuild/repo-wiki/zh/`: actual recovered project files; `pages/overview.md` contains `# Human edit` and the verified human text.

Temporary source trees/DBs are cleaned after tests; only the explicit copied evidence above remains.

## Scope handoff

Core owner owns the full migration/conflict/card/failure-recovery matrix. UI owner owns renderer and `repo-wiki` harness evidence. Root owner owns combined typecheck/build/notes verification and final diff review. These are not claimed as run by task 5. No unrelated UI scenarios or repository-wide test suite was run here.
