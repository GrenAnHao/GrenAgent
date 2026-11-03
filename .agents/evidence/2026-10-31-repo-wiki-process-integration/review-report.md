# Repo Wiki v3 integration review

Reviewed 2026-10-31 in the existing checkout. Read-only review; the only reviewer-created file is this report. No code edits, commits, pushes, test reruns, or child agents. Unrelated pre-existing working-tree changes were excluded.

## Findings

No confirmed important defect was found in the requested integration scope. There is no code-review blocker from this review. This is a static quality conclusion, not a claim that all final validation has completed.

## Scope and specification

Read the repository AGENTS.md, the proposed integration and Windows Git-identity notes, and `electron-agent/vendor/repo-wiki/docs/GRENAGENT_INTEGRATION.md`. The accepted design is the original v3 panel embedded in GrenAgent, with a genuinely separate OS process owning the engine, scans, Git, SQLite, generation jobs, and watchers. Host integration is limited to registration, current-window/frame authorization, host project roots, a cancellable short-call model broker, lifecycle, and build/packaging. AgentData storage and contracts remain separate.

Reviewed the new vendor implementation and the narrow host changes in `repoWikiService.ts`, `main.ts`, command registration/disposal, worker entry/build helpers, Repo Wiki renderer integration, module navigation, the targeted UI harness, package/build configuration, and license collection.

## Boundary and lifecycle assessment

| Area | Code evidence | Assessment |
| --- | --- | --- |
| Actual trusted window/frame | `electron-agent/electron/app/repoWikiService.ts:15` | Requires the current non-destroyed main window, its exact WebContents, BrowserWindow ownership, the actual main frame with no parent, and matching current app-page URLs. A matching URL alone is insufficient. |
| Host-owned roots | `electron-agent/electron/main.ts:341`; `electron-agent/electron/app/repoWikiService.ts:119`; vendor Electron registration `packages/electron/src/index.ts:68` | Renderer paths do not grant access. Roots come from host project records, are canonicalized, and are checked in the host bridge and child. Embedded clone is rejected. Event recipients are reauthorized individually before send. |
| Empty roots and revocation | `electron-agent/electron/app/repoWikiService.ts:125`; `electron-agent/electron/ipc/register.ts:624`; `electron-agent/electron/main.ts:430` | Empty roots stop the old child rather than enabling upstream's unrestricted standalone mode. Project removal awaits a configuration refresh. The idle poll also notices changed authority. Failed authority/configuration resolution stops the previous child. |
| Model identity and replacement | `electron-agent/electron/main.ts:354`; `electron-agent/electron/app/repoWikiService.ts:125`; vendor `packages/process/src/host-provider.ts` | The child receives an opaque hash, not raw model configuration or credentials. The completion closure is bound to the model represented by the identity. Serialized transitions stop the previous supervisor before replacement; submitted commands are not retried. |
| Normal generation | `electron-agent/electron/app/repoWikiService.ts:92`; vendor App generation/consent flow; vendor service dispatch | Host generation rejects demo and forces real. The original embedded UI defaults to real and retains per-request external-source consent. The watcher does not silently send real-model requests. |
| Cancellation and shutdown | vendor `packages/process/src/client.ts:155`, `:264`; `packages/process/src/child.ts:105`; `electron-agent/electron/main.ts:478` | Model-cancel messages reach AbortControllers. Stop removes registration/listeners, waits for transitions and the child, and shuts Repo Wiki down before the other model-host dependencies. Child disconnect also runs cleanup. |
| Crash handling | vendor `packages/process/src/client.ts:186`; service run-state restoration | Pending commands reject on exit, model calls abort, restart count is bounded, and mutations are not replayed. Restored active jobs become interrupted. Renderer project/run polling recovers authoritative state rather than treating a single progress event as completion. |
| Original interface and editing | `src/features/repoWiki/RepoWikiWorkspace.tsx:10`; `src/stores/moduleStore.ts:27`; vendor `apps/web/src/App.tsx:604` | Embeds the actual RepoWikiPanel with routing disabled. Existing collection, Wiki, cards, reader, source, editing, plan, import/export and language UI are retained. Navigation guards block leaving during mutations and preserve unsaved edits when leaving is rejected. Guard cleanup checks identity. |
| Renderer unmount/remount | vendor `packages/renderer/src/index.ts`; vendor App `:571`; `src/features/workspace/ModuleContainer.tsx:26` | Subscription acquisition after disposal is released, late callbacks are suppressed, and App effects release polling/subscriptions. Repo Wiki unmounts when leaving its module. |
| Separate production child | `electron/agent/repoWikiHostBuild.ts:4`; `electron/agent/workerEntry.ts:27`; `electron.vite.config.ts:86`; `electron-builder.yml:63` | Separate esbuild invocation produces one CJS child targeting Node 22. Runtime path resolves beside dev main or beneath `app.asar.unpacked/out/main` in production. The child does not enter the bytecode transform. Packaging explicitly unpacks the same filename. The build test checks one output and only external `node:` imports from an unrelated ESM directory without node_modules. |
| Dependencies/licenses | `electron-agent/package.json`; `scripts/collect-third-party-licenses.cjs:129` | Host dependencies supply vendor runtime imports. The inventory follows installed production dependencies, includes multiple versions and peers, applies packaging exclusions, and includes the vendored MIT license and third-party notices. |

## Windows Git identity change

`electron-agent/vendor/repo-wiki/packages/core/src/scanner.ts:412` changes only the Git null-device spelling on Windows from Node's `\\.\nul` to Git-compatible `NUL`. It retains stripping inherited `GIT_*` variables, disabled global/system configuration, `GIT_OPTIONAL_LOCKS=0`, noninteractive Git, `core.fsmonitor=false`, disabled hooks, bounded command execution, and hidden Windows subprocesses. Dirty-state comparison still hashes source bytes directly instead of invoking Git filters. The restriction is preserved by inspection.

The parent reports a pre-fix failing targeted branch/card regression and a same-command device-path comparison. This reviewer did not rerun or independently reproduce that evidence.

## Verification evidence and limits

Per the delegated instruction, no tests or builds were repeated. Existing files inspected include `frontend-vitest.log`, `frontend-ui-retry.log`, `frontend-report.md`, `build-tests.log`, `upstream-tests.log`, `electron-build.log`, and `electron-child-tests.log` in `.tmp-repowiki-source/`.

- The inspected frontend log records 5 files / 33 tests passed.
- The inspected real Electron UI log records 37 assertions passed, 0 failed, for `repo-wiki` only; 1 of 44 scenes ran. It covers actual module navigation, original views, save failure/retry, consent, cancellation, leave protection, repeated mount/unmount, and listener/poll cleanup using deterministic main I/O.
- The earlier build-tests log still records two 5-second license-test timeouts. The earlier upstream-tests log records Windows WAL locking, an HTTP 413 reset expectation, and overall workflow timeouts. These are not presented as a passing final suite.
- While this review was active, the parent confirmed that these earlier failures are being reconciled by the owning agents, that a full build and strict typecheck have separately completed successfully, and that the first real Electron child workflow passed in 40.5 seconds. Final consolidated runtime/typecheck/license evidence remains the parent's responsibility.

The reviewer did not launch a paid model request, independently run an installed production package, or modify unrelated work. Static inspection supports the requested process and interface architecture; final acceptance must use the parent's completed validation record. No action was denied or awaiting reviewer permission.

## Targeted follow-up review

Reviewed the final portability changes and the new host test runner without rerunning tests. No additional important defect or acceptance weakening was found.

- `vendor/repo-wiki/packages/service/src/http.ts:36` sends the complete 413 JSON with an explicit Content-Length before draining the remaining upload. The loop at `:99` uses `iterator({ destroyOnReturn: false })`, so leaving it does not destroy the socket before the error reaches Windows clients. The 8 MiB threshold remains, excess bytes are discarded rather than retained/parsed, and no child command is dispatched. The regression at `packages/service/tests/http.test.ts:235` requires actual JSON 413 responses for declared, chunked, and still-open uploads, plus zero child calls. It does not accept ECONNRESET as success. The documented incomplete-upload connection lifetime follows the server's existing timeout/connection policy.
- `vendor/repo-wiki/packages/core/tests/migration.test.ts:234` now creates a genuine uncommitted WAL suffix by forcing cache spill, proves WAL growth, copies DB/WAL synchronously to an offline snapshot before rollback, and migrates that snapshot. It checks the original committed project name, every human page/proposal/archive, and unchanged source bytes before and after reopening the migrated database. SHM is excluded only from this crash-like offline fixture; the separate committed-WAL test still verifies unchanged DB/WAL/SHM. The production migration restriction to offline/quiescent sources is unchanged.
- `scripts/test-repo-wiki.mjs:29` enumerates every package tests directory, rejects an empty test list, builds a temporary standalone child, invokes Node's real test runner with concurrency 2, and selects the actual Electron executable for service-child tests. Exit failure is propagated and the normal/error path removes build output in finally. No skip or assertion suppression was introduced.
- `packages/process/tests/service-child.test.ts:104`, `:246`, and `:344` increase only Windows overall workflow timeouts to 90/60/60 seconds. The 5-second request deadline, 8-second run polling limit, bounded startup/restart waits, PID checks, cancellation, persistence, and no-leftover-process assertions remain.
- The added bug-fix note explains both reproduced causes and why accepting resets, skipping Windows, or rolling back before capturing WAL were rejected. Its acceptance criteria preserve the relevant contracts.

Nonblocking runner hardening suggestion, communicated to the parent: unlike `scripts/test-codegraph.mjs`, the reviewed runner does not explicitly forward SIGINT/SIGTERM to its spawned test runner. Normal completion/error cleanup is present; an explicit signal sent only to the parent can interrupt it before finally and leave tests or temporary build output until later cleanup. Consider forwarding termination and awaiting child exit before cleanup. This is not a product integration or normal-run acceptance blocker.

Additional evidence inspected: `portability-tests.log` records 20 tests passed, 0 failed; no independent rerun was performed. `window-smoke.log` contains a successful native-preload/native-invoke receipt with main PID 24960, child PID 85456, independent-process=true, cross-window rejection=true, post-navigation rejection=true, and stopped=true. The parent separately reports a successful unpacked production-path smoke. At this review point, the all-vendor test run and final consolidated portability/typecheck reports are still being completed by their owners.
