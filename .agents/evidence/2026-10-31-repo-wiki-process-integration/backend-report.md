# RepoWiki backend integration report

Implemented in the existing workspace without committing, pushing, creating a worktree, modifying vendor sources, or calling a paid model.

## Files owned by this task

- `electron-agent/electron/app/repoWikiService.ts` (new): main-safe service using the vendored `RepoWikiProcessClient` and `registerGrenRepoWiki`; stable IPC registration, dynamic supervisor replacement, model broker, sender authorization, and awaited stop.
- `electron-agent/electron/app/repoWikiService.test.ts` (new): real vendor registration/supervisor with an actual OS child wire fixture. Only repository engine and paid model responses are deterministic fixtures.
- `electron-agent/electron/main.ts` (narrow additions to existing dirty file): creates service, uses `userData/repo-wiki`, supplies trusted `WorkspaceService.listProjects()` roots, binds the resolved default `ModelRuntimeHost` model and abort signal, refreshes after provider changes, and awaits stop before other application cleanup.
- `electron-agent/electron/agent/workerEntry.ts`: adds `resolveRepoWikiHostEntry()` for dev `mainDir/repo-wiki-host.cjs` and packaged `resources/app.asar.unpacked/out/main/repo-wiki-host.cjs`.
- `electron-agent/electron/agent/repoWikiWorkerEntry.test.ts` (new): dev/production CJS path coverage.
- `electron-agent/electron/ipc/register.ts` (narrow additions to existing dirty file): `registerCommand()` returns a disposer that cannot remove a replacement; optional `workspaceProjectsChanged` callback makes `remove_project` await permission synchronization.
- `electron-agent/electron/ipc/register.dispose.test.ts` (new): safe disposal and immediate project-removal synchronization.

## Behavior and boundaries

- No engine, scanner, SQLite, or provider implementation is imported into the main-process service.
- Sender checks require the real host main window's `webContents`, `BrowserWindow.fromWebContents` ownership, the current `mainFrame` object, no parent frame, and trusted current frame/webContents URLs. The pure exported `isTrustedRepoWikiSender()` is available to the parent smoke test.
- Approved roots are realpathed, deduplicated, and sorted. Roots come only from trusted host project records; RepoWiki does not call `ensureWorkspace()` to grant itself access.
- Removing a project synchronizes immediately. Idle supervisors also recheck host records/model configuration every 2 seconds; unused services do not start a child.
- The upstream meaning of `allowedRoots: []` is unrestricted standalone access. The host never launches a child with no approvals: it stops the prior child, returns empty projects/safe health, and rejects project actions with 403. Registry/configuration read failure also stops the existing child.
- Model identity hashes provider, model and configuration; raw configuration and credentials are not sent to the child. The completion closure captures the exact resolved model and forwards system/user/maxTokens and AbortSignal to `ModelRuntimeHost.completeSimple()`.
- No configured model still permits offline browsing; health reports `real_configured: false`. Real generation fails through the model broker.
- Embedded generation defaults to `provider: real` and rejects explicit `demo`. Vendor external-generation confirmation remains enforced by the real child.
- Configuration transitions stop the old supervisor before replacement. No submitted mutation is retried or replayed. Vendor bounded crash restart remains in use. Event recipients are reauthorized individually on every progress event.
- `stop()` removes commands/listeners, cancels configuration polling, waits for pending transitions and child shutdown, and is idempotent. The application quit chain awaits it while the model host is still available.

## Verification

Tests were written and observed failing before production changes. New guard regressions were also observed failing before their fixes.

Final command from `electron-agent`:

```text
npx vitest run electron/app/repoWikiService.test.ts electron/agent/repoWikiWorkerEntry.test.ts electron/agent/workerEntry.test.ts electron/ipc/register.dispose.test.ts electron/ipc/register.test.ts --project main
Test Files 5 passed (5)
Tests 52 passed (52)
```

Evidence: `.tmp-repowiki-source/backend-vitest.log`.

Strict standalone typecheck of the service, its tests and the new worker entry test passed:

```text
npx tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop --types node,vitest/globals electron/app/repoWikiService.ts electron/app/repoWikiService.test.ts electron/agent/repoWikiWorkerEntry.test.ts
exit 0
```

Evidence: `.tmp-repowiki-source/backend-targeted-types.log` (empty diagnostic output).

The full `tsconfig.node.json` check was also attempted and remains red with 150 diagnostics in unrelated code/tests (for example existing SQLite typing, test fixtures, missing `vitest` resolution under CLI, and project inclusion problems). The latest full log has no diagnostics for `repoWikiService`, `repoWikiWorkerEntry`, `main.ts`, production `ipc/register.ts`, or the imported RepoWiki vendor files. Full log: `.tmp-repowiki-source/backend-typecheck.log`.

The sandboxed first Vitest attempt failed before collecting tests because Windows denied renaming Vitest's transform cache. Approved escalated runs used the normal temporary directory and completed successfully. No action remains denied or pending.

## Scope left to parent integration

The parent/build agent owns child bundle construction and packaging, renderer/UI checks, upstream engine tests, real Electron BrowserWindow authorization smoke, and the real bundled child PID/persistence/cancellation/crash smoke. This backend task did not duplicate those checks. The root decision note was read before editing and is maintained by the parent.
