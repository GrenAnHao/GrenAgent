# Repo Wiki Windows portability report

Scope: only `electron-agent/vendor/repo-wiki/packages/core/tests/migration.test.ts`, `packages/service/src/http.ts`, and `packages/service/tests/http.test.ts`, plus the required independent decision note and temporary verification artifacts. No commit, push, dependency, configuration, frontend, backend, migration-runtime, or other module changes.

## Root causes and changes

1. **Migration EBUSY:** the original test calls `hashes(source)` while SQLite holds a write transaction. Windows refuses reads of the locked SHM byte range before migration runs. Migration itself explicitly supports offline/quiescent snapshots, not hot backup. The fixture now forces an actual uncommitted transaction to spill with `cache_size=1`, asserts WAL growth, copies DB/WAL before rollback to a separate offline source, and migrates that snapshot. It checks every human page (edited text, conflict proposal, archived text), the committed project name, and unchanged source bytes before and after reading the destination. The separate committed-WAL case still asserts DB/WAL/SHM bytes unchanged. No Windows skip or migration runtime change.

2. **HTTP ECONNRESET:** a thrown 413 closes the default async iterator and destroys IncomingMessage/socket before clients read the response. A probe observed server `requestDestroyed=true` and client ECONNRESET. `iterator({destroyOnReturn:false})` alone removes that destruction, but Windows still resets when Node finishes a Connection:close response while upload bytes remain unread. The fix sends the complete JSON 413 immediately with Content-Length, discards remaining request bytes without buffering, and finalizes the response after request end. Tests require actual status 413 plus complete JSON detail for declared, chunked, and still-open chunked requests, and require zero child invocations. No connection error is converted into success.

An incomplete sender can keep its connection until completion, disconnect, or the server's existing request timeout; its complete 413 response is already available. Body-limit rejection retains no further uploaded data and starts no child action.

The rejection explicitly sends `Connection: close` so a keep-alive client cannot reuse a connection with an unfinished upload. That regression first failed with actual `keep-alive` versus expected `close`, then passed after the header fix.

## Verification

- Before edits, both targeted tests reproduced their original EBUSY / ECONNRESET failures with ordinary Windows permissions. The sandbox additionally blocks symlinks and loopback client connections, so real-server tests ran via approved `require_escalated` local execution.
- `node --import tsx --test packages/core/tests/migration.test.ts packages/service/tests/http.test.ts`: **20 passed, 0 failed, 0 skipped**. See `portability-tests.log`.
- `node electron-agent/node_modules/typescript/bin/tsc -p .tmp-repowiki-source/portability.tsconfig.json --noEmit`: **passed**, checking all three changed files and their transitive imports. See `portability-types.log` (empty output, exit 0).
- `npm run verify-notes`: **passed**. Six existing notes have result-wording warnings; no new warning. See `portability-notes.log`.
- Diagnostic probe after the fix: declared **client response 413**, chunked **client response 413**, **child invokes 0**. Probe: `http-body-probe.mts`.

The imported vendor subset has no standalone `tsconfig.json`; an initial `npx tsc -p tsconfig.json --noEmit` attempt therefore returned TS5058. No project configuration was added or altered; the temporary scoped host configuration above supplies the successful check.

The parent already ran the original 194-test upstream suite and is handling the separately scoped child-process timeouts. This subtask did not repeat that full suite or modify those tests. There are no remaining blockers in the delegated migration/HTTP scope.

Decision note: `.agents/notes/implemented/bug-fix/2026-10-31-repo-wiki-windows-stream-and-wal-tests.md` (created as proposed before runtime edits, moved to implemented with verification evidence).
