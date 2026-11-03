# Pi 1.4 SDK compatibility evidence

## Scope and preservation

Before changes, the repository already had modifications in `cli/src/gren-runtime.ts`, `electron-agent/electron/agent/workspaceHandle.ts`, and `extensions/_shared/session-cwd.ts`. No production file has been changed by the compatibility task. The new test is `extensions/_shared/pi-sdk-compat.integration.test.ts`.

The test uses real Gren runtime creation and real Pi services/sessions, an isolated temporary agent directory/model configuration/JSONL session, and an HTTP SSE server bound to `127.0.0.1`. It uses a literal fixture key and does not load user auth files, real workspace data, or a paid provider.

## Baseline: installed Pi 1.3.0

| Selection | Result | Log |
| --- | --- | --- |
| extensions: tool-refresh-batch, session-cwd, shared/extension header-placeholders, working-directory, compaction-policy, session-memory | 129 passed; 5 working-directory cases blocked by sandbox native realpath | `baseline-extensions-retry.log`, `baseline-extensions-localtemp.log` |
| working-directory plus new real SDK compatibility integration, rerun outside sandbox | 8 passed: 5 working-directory and 3 SDK integration | `baseline-sdk-compat-unsandboxed.log` |
| electron: workspaceHandle, sessionUiAdapter, streamingEvent, eventAdapter, syncSessionFromDisk, contextUsageEstimate | 6 files / 93 passed | `baseline-electron-retry.log` |
| CLI gren-runtime node:test | 8 passed | `baseline-cli-runtime.log` |

Vite's default sandbox temporary directory caused pre-test rename `EPERM`; setting `TEMP` and `TMP` to a task-local directory solved cache creation. Native `realpathSync.native` and loopback HTTP remained restricted inside the sandbox. The automatic reviewer allowed rerunning isolated fixture tests outside it; unchanged tests then passed. Initial unsuccessful environment runs remain in the logs and are not SDK failures.

## Real SDK behavior covered

- Real Gren `makeGrenRuntimeFactory` calling `createAgentSessionServices` and `createAgentSessionFromServices`, then `bindExtensions`.
- Three dynamic `pi.registerTool` calls remain absent until the batch exits, cause exactly one real `_refreshToolRegistry` refresh, and become visible together.
- `attachSessionCwd` updates `_cwd` and the real `ExtensionRunner` context while preserving the session header directory.
- Real prompt acceptance reports `preflightResult('started')`.
- `header-placeholders` expands the session header on the actual local HTTP request and preserves a static provider header.
- A real manual default compaction makes local provider requests and emits a successful non-extension compact event. The baseline characterized the 1.3 output budget derived from `reserveTokens`; the 1.4 assertion now verifies its intentional model-output-limit behavior, described below.
- Default compaction refreshes finalized message context, writes the JSONL compaction entry, reconstructs a compaction-summary message when the file is reopened by `SessionManager`, and accepts a successful subsequent prompt with the expanded session header.
- Existing `syncSessionFromDisk` tests exercise the real `_refreshFinalizedContext` with disk rewind, and the selected app tests cover workspace/preflight/session UI/event projections.
- The final integration also binds the real `SessionUiAdapter` to the real SDK runner, receives an extension notification with the current session identity, and projects the real SDK event stream into renderer deltas and started/completed turns.

## Pi 1.4.0 comparison

| Selection | Result | Log |
| --- | --- | --- |
| same extensions selection plus SDK compatibility integration | 21 files / 137 passed | `upgraded-extensions.log` |
| same electron selection | 6 files / 93 passed | `upgraded-electron.log` |
| same CLI gren-runtime test | 8 passed | `upgraded-cli-runtime.log` |

There was no production compatibility failure and no production code change. The runtime factory/services, dynamic registry batching, private cwd/runner fields, finalized-context refresh, headers, preflight, session UI, event projection, and compaction/JSONL paths continue working with the installed official 1.4.0 packages.

One intentional SDK behavior changed: `generateSummaryWithUsage` in the installed 1.4 source documents `_reserveTokens` as unused compatibility input and uses the model's output limit (upstream #9512). The real fixture summary HTTP request consequently changed from a budget at or below reserve `1000` to the model limit `4096`. The integration assertion now expects literal `4096`; no local production override was added. The initial failing observation is retained in `upgraded-sdk-compat-initial.log`. That run began during the dependency switch; the file was renamed after confirming its installed SDK was 1.4, so it is not presented as baseline evidence.

During final fixture development, an event assertion initially selected `text_start` instead of `text_delta`; it was narrowed to the actual delta event. This was a test selection error and did not require production changes. The new test's initial type mistakes (required tool result `details` and no public `session.cwd` getter) were also corrected before final verification.

Only these task-related test selections ran. No UI source changed, no UI harness scenario was needed, and unrelated suites were not expanded to a full run.

## Typecheck comparison

`cli`'s `tsc --noEmit` returned exit 2 both before and after the upgrade, with 82 existing TS diagnostic lines. Comparing the complete final outputs with `Compare-Object` produced no differences. The new compatibility test and the real UI/event modules it imports introduce no diagnostics. Logs: `baseline-compat-types.log`, `upgraded-compat-types.log`. Root's earlier type snapshots caught the fixture's intermediate authoring state; these final logs supersede those two fixture-specific intermediate errors for this comparison.

## Additional offline configuration/authentication boundary checks

After a read-only review of all four test files and their service dependencies, these four selected files ran against installed Pi 1.4 without implementation changes. Result: **4 files / 62 tests passed**, exit 0. Log: `upgraded-config-auth-offline.log`.

| File under `electron-agent/` | Passed | Verified boundary |
| --- | --- | --- |
| `electron/app/providerService.test.ts` | 17 | JSON validation and real temporary `agentDir/models.json` and `agentDir/auth.json` persistence/readback; malformed models JSON writes neither file; injected model-probe/HTTP/oneshot requests, custom headers, API-key header precedence, session placeholder, diagnostics and cancellation. |
| `electron/agent/runtimeConfigBootstrap.test.ts` | 3 | A supplied temporary `runtime-settings.json` path, missing parent directory/file creation, assignment to `PI_RUNTIME_CONFIG`, watcher startup/restart and isolation from workspace AsyncLocalStorage. |
| `electron/agent/modelRuntimeHost.test.ts` | 17 | Injected runtime construction once/concurrently/retry after rejection, refresh retaining instance identity, configured-auth model selection/fallback/unavailable behavior, short-call option forwarding, streaming and error/usage propagation. Every runtime factory is a test substitute; this does not authenticate an SDK provider. |
| `src/features/settings/providerConfigAdapter.test.ts` | 25 | Pure JSON load/serialize: built-in API keys use `auth.json` entries `{ "type": "api_key", "key": "..." }`; custom provider keys use `models.json.providers.<id>.apiKey`; provider/model/header/compatibility/price and thinking-level fields round-trip; published `$schema` remains accepted. |

Isolation was established in the test process before launch: `TEMP` and `TMP` point to the task's `temp-auth-config` directory; inherited `PI_RUNTIME_CONFIG` is cleared; `PI_CODING_AGENT_DIR` points to a fresh `isolated-agent` subdirectory there. File-writing test cases allocate their own `mkdtemp` directories and clean them up. The `C:/agent` strings in the remaining ProviderService cases are placeholders used only with injected fetch/probe/oneshot implementations, and do not reach a filesystem API in those cases. Provider endpoint requests are replaced with test responses. No user auth/config files or paid endpoints were accessed.

**OAuth limit:** these four files do not call OAuth login, logout, token refresh, authorization-code exchange, browser callback, or a real SDK OAuth handshake. They exercise API-key JSON and injected auth-availability/error boundaries only. OAuth credential serialization/preservation and real handshake interoperability are therefore **not verified** by these tests. No claim of live OAuth compatibility is made. The renderer test run printed a Node `--localstorage-file` warning, but all assertions completed successfully.

## Tool prompt metadata gate

The new SDK fixture registers three temporary tools with nonempty `description` and `promptSnippet`, so the repository's required prompt metadata gate also ran: `extensions/prompt-metadata.test.ts`, **4/4 passed**, exit 0. Log: `upgraded-prompt-metadata.log`. No product tool or UI source was changed.
