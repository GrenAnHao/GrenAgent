# Repo Wiki frontend integration

Implemented in the existing checkout without committing or pushing. Existing unrelated working tree changes were retained.

## Deliverables

- `electron-agent/src/features/repoWiki/RepoWikiWorkspace.tsx` embeds the actual v3 `RepoWikiPanel` through `createGrenRepoWikiClient({ invoke, subscribe: listen })` and the existing platform runtime. No HTTP/demo app or renderer supplied authorization is used.
- `moduleStore.ts`, `ModuleRail.tsx`, and `ModuleContainer.tsx` add a dedicated **Repo Wiki** entry. Chat remains mounted; Repo Wiki unmounts on exit. Module leave guards retain unsaved edits when the user rejects leaving and prevent navigation while a mutation is pending. Guard disposal is identity checked so stale cleanups cannot clear a newer guard.
- The panel receives the latest `activeWorkspace`. Connecting a local repository prefills the path; **使用当前工作区** refreshes it after a workspace switch. Main remains responsible for authorization.
- Minimal vendor UI adaptations add the host close action, workspace path input, and navigation guard. All original collection/overview/Wiki/cards/reader/edit/source/plan/import/export/watch/language features remain in the real App. Embedded generation defaults to `real`, has no demo model choice or demo path shortcut, and retains per-request source consent. Standalone App behavior is retained.
- `workspace/api.ts` uses a local structural bridge cast instead of an incompatible global `Window.gren` redeclaration, preserving renderer and standalone compatibility.
- `ui-harness/scenarios/repo-wiki.tsx` mounts the real navigation, module container and vendor components. Only main I/O and the native confirmation response are stubbed. `probes/repo-wiki.mjs` covers navigation, current workspace, Wiki/cards, read/source views, actual source evidence, edit preservation, failed save/retry, real-model consent, cancel/retry, repeated entry/exit, subscription disposal and polling cleanup.

## Verification

- Final targeted Vitest command:
  `npx vitest run src/features/repoWiki/RepoWikiWorkspace.test.tsx src/features/repoWiki/repoWikiClient.test.ts src/stores/moduleStore.test.ts src/features/layout/ModuleRail.test.tsx src/features/workspace/ModuleContainer.test.tsx`
  **5 files, 33 tests passed.** Log: `frontend-vitest.log`.
- `npm run ui:check -- repo-wiki`: **37 passed, 0 failed**, real Electron 38.8.6, production build, hidden/offscreen window. Only **1/44** scenes ran; the other 43 were not run. Log: `frontend-ui-retry.log`.
- Visually inspected collection, Wiki overview and card-reader screenshots. Original light forest-green layout and complete content are preserved. Screenshots are copied to `frontend-shots/`.
- Production Repo Wiki type checking was run by the build owner using `electron-agent/tsconfig.repo-wiki.json`; it includes `RepoWikiWorkspace`, its transitive vendor UI, and the fixture, and passed. The broader temporary diagnostic including the existing entire ModuleContainer dependency graph reports existing AgentData/mcpConfig/SettingCard errors; these unrelated files were not changed. The new frontend tests' diagnostic type errors were corrected.
- `git diff --check` for the owned tracked frontend files passed.

## Environment findings and limits

The first sandboxed Electron GUI launch exited before loading the scenario: status **2147483651 / 0x80000003**, signal/error null, stderr empty (`frontend-electron-probe.log`). The normal escalated hidden test successfully launched; a probe API argument error was then fixed and the scene passed all 37 assertions. Electron logs a missing `chrome_100_percent.pak` warning, but it loaded and executed the complete scene. No Electron upgrade or alternate browser was used.

No remaining frontend blocker. The scenario uses deterministic main I/O; actual process, model broker, persistence, packaging, and authorization are verified by the backend/build owners. No paid model request was made by the frontend tests. Embedded remote clone remains subject to the existing main contract that only permits approved local repositories; the original upstream controls are retained and main errors are displayed in the existing UI.

The parent should add `repo-wiki` to the repository AGENTS.md scene list and record these results in the shared integration note/evidence. This agent did not edit shared package/config/main/backend files or the shared decision note.
