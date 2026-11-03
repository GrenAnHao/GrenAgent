# Task 4 report: instant host UI and scoped preparation

Status: implemented; focused verification passed. No commits, pushes, paid providers, user-app restarts, real-project migrations, or user-DB mutations were performed.

## Scope and behavior

- `RepoWikiWorkspace.tsx` renders `registeredProjects` and `activeWorkspace` synchronously as independent `HostProjectSummary` display records. A pending/error host snapshot cannot erase the already loaded renderer list. Only a ready snapshot replaces it. No Wiki Project or database ID is invented.
- Activation only binds a context. `repoWiki_hydrate({__repoWikiContext})` prepares the current project asynchronously; the local status/retry line and current project name stay above a usable seven-project collection while I/O is unresolved. Switching a project still calls the existing `pi.openWorkspace` / `applyOpenedProject` host flow. Language selection calls lightweight activation with `language`, followed by hydrate; it does not create a namespace first.
- The fixed 2.5-second detail/changes refresh was removed. Initial detail/changes are loaded once; terminal progress events refresh metadata. Only a live run has a lightweight timeout fallback, scheduled after the previous status read settles. Initial and periodic reads share an in-flight status promise. Events invalidate older status replies. Switching/closing cleans up timers and subscriptions.
- Each panel mount creates one stable independent UUID and supplies it as `view_id` on every activation (including language, lifecycle refresh and retry). Host activation rotates the token for a different view even at the same path. Unmount releases the captured context through `repoWiki_release`; stale releases cannot retire a newer token. Renderer registration changes alone do not release a live context. Requests and progress retain workspace/token, child-instance, sequence and retired-run checks.
- Existing Wiki/card reading, Markdown/source views, source citations, per-language namespaces, generation consent/cancel/error/retry, A-B-A and child-restart drafts, save errors and module-leave protection remain. The forest green design and collection illustration are preserved.
- Page edit/resolve sends the original `page.storage_token` as `expected_storage_token`; plan edits capture `plan_storage_token` when opened and send `expected_plan_storage_token`. External-edit conflicts keep the original draft. Renderer generic request routing already preserves these validated fields, so it needed no additional adapter mutation.
- Runtime fixtures now initialize only the requested project on hydrate; activation and host listing do not pre-create a Wiki registry. Namespace documents and CAS tokens remain separate, and fixture context IDs are unique per fixture. Host/store state is reset between React cases.

Owned product/test files: `electron-agent/src/features/repoWiki/{RepoWikiWorkspace.tsx,RepoWikiWorkspace.test.tsx,testing/runtimeFixture.ts}`; `electron-agent/vendor/repo-wiki/apps/web/src/{App.tsx,RepoWikiPanel.tsx,workspace/ProjectCollection.tsx,workspace/collection.css,workspace/api.ts}`; `electron-agent/ui-harness/{scenarios/repo-wiki.tsx,probes/repo-wiki.mjs}`. Main/service/process/core were not edited by this task.

## RED and final checks

All commands ran from `electron-agent` unless prefixed otherwise. TEMP/TMP were set to the isolated workspace `.tmp-repowiki-optimization` directory because the sandbox's virtual temporary cache rename returned EPERM. Electron required the approved elevated isolated test process; the sandboxed child exited before starting its probe. No user Electron instance was restarted.

| Command | Result | Saved stdout |
| --- | --- | --- |
| `npm test -- --run src/features/repoWiki/RepoWikiWorkspace.test.tsx -t 'shows seven host summaries'` before product changes | RED: missing 当前宿主项目 region; 1 failed / 19 skipped | `task-4-red-react.log` |
| `npm test -- --run src/features/repoWiki/RepoWikiWorkspace.test.tsx -t 'same-path remount token'` before view ownership fix | RED: late disposed activation released the remount's token; 1 failed / 27 skipped | `task-4-remount-red.log` |
| same first-frame test after implementation | GREEN: 1 passed / 19 skipped | `task-4-green-first-frame.log` |
| `npm test -- --run src/features/repoWiki/RepoWikiWorkspace.test.tsx src/features/repoWiki/repoWikiClient.test.ts` | 2 files, 30 tests passed | `task-4-react-final.log` |
| `npm run test:repo-wiki-ui` | 9 files, 71 tests passed | `task-4-vendor-ui-final.log` |
| `npm run typecheck:repo-wiki` | exit 0 | `task-4-typecheck-final.log` |
| `npm run ui:check -- repo-wiki` | 76 assertions passed, 0 failed; only 1/44 scenarios ran, 43 not run | `task-4-harness-raw-utf8.log` (raw UTF-8 subprocess capture) |

React additions cover seven summaries before any activation response, seven summaries while hydrate never returns, selection during that hold and rejection of the stale reply, pending host snapshot preservation, registry changes without context release, running-context unmount, delayed stale cleanup after a new workspace token binds, and deferred activation followed by immediate same-path remount without revoking the new view, no overlapping status polling or recurring detail/changes reads, and page/plan CAS conflicts. Existing React regressions cover the other reading, draft, namespace and event-order behavior.

Intermediate logs are retained (`task-4-react-first.log`, `task-4-react-second.log`, `task-4-harness-first.log`, `task-4-harness-second.log`, `task-4-harness-final.log`). Intermediate failures were the expected renamed local loading/error selector, the removed collection `/projects` request, and test-state contamination from a prior `draftConversationCwd`; these were corrected without changing unrelated host behavior. Some PowerShell-redirected intermediate logs have console decoding artifacts; the authoritative final harness log is raw UTF-8.

## First-visible measurement and screenshots

The final production Electron run measured **318.8 ms** from the captured real ModuleRail click to the first DOM commit with the current host project name/shell and all seven already loaded host summaries. Both activate and hostProjects responses were held indefinitely until after the probe verified this DOM and captured its screenshot. At that point the Wiki registry had **0** projects; only the current one appeared after preparation was released. This specifically verifies shell visibility before backend return rather than a completed fixture hydrate.

The run used a fresh renderer/module mount, an offscreen Electron window, and deterministic blocked main I/O. Vite rebuilt separately in 5.9 seconds; build time is excluded from the first-visible figure. `task-4-first-visible.json` records exact timing boundaries and numeric values. This is **not** directly comparable to the prior **33.48-second real local 7-project activate sample**: that sample includes real service/model/filesystem work and uses a different timing boundary. No real seven-project cold-start measurement or migration was attempted.

Screenshots in `grenagent-ui-shots/`: `repo-wiki-cold-host-first-frame.png`, `repo-wiki-collection.png`, `repo-wiki-overview.png`, `repo-wiki-card-reader.png`, `repo-wiki-generation-consent.png`, `repo-wiki-scratch-empty.png`. The cold first frame was visually inspected: current Forest heading, local preparation line, all seven cards and the forest green illustration are visible. The harness also checks source reading, generation, token cancellation and listener cleanup. Only the Repo Wiki scenario ran; no global/theme or unrelated scenario was changed.

## Integration limits

- UI main-I/O fixtures prove renderer behavior, not real service authorization, migration, OS child scheduling, or model cancellation. Those are owned by the host/process/core task tests.
- The initial-activate-response / immediate same-path remount ownership race was reproduced with a RED React test (`task-4-remount-red.log`) and fixed jointly with the host owner using `view_id`. Final React 30/30 includes this case and a real page read after the late old response. The final 76-assertion Electron run includes the view ownership addition. The host owner separately verified backend view ownership (23/23).
- Root-owned final build and verify-notes remain the integrating agent's checks; this task's scoped typecheck and UI checks passed.

## Follow-up: generation confirmation copy

The embedded real-generation confirmation now labels the row `模型配置` and states `使用系统知识模型，生成时检查配置`; it does not claim health has already resolved the model or describe environment variables as the host configuration source. The standalone branch retains its existing health-based wording. No precheck, provider call, scan, or new preparation step was added.

The actual Repo Wiki probe gained this exact wording assertion and `repo-wiki-generation-consent.png`. Before the product copy change, the new assertion failed (`task-4-consent-red.log`, 75 passed / 1 failed, exit 1). Afterward only `npm run ui:check -- repo-wiki` was rerun: 76 passed / 0 failed, exit 0, 1/44 scenarios; authoritative raw UTF-8 output is `task-4-harness-raw-utf8.log`. The refreshed first-visible sample is 318.8 ms (previous isolated UI sample 319.6 ms); separate production build 5.9 seconds. `task-4-first-visible.json` and all six final screenshots were refreshed. The confirmation screenshot was visually inspected and the requested row is readable without clipping. No other UI scope was expanded.
