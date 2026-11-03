# Agent Note: Repo Wiki Windows body-limit response and offline WAL fixture

Status: implemented

## Problem

The v3 HTTP preview uses the default request async iterator. Throwing when a chunk crosses the 8 MiB body limit closes that iterator and destroys the IncomingMessage/socket before the JSON 413 reaches the Windows client. A local probe confirms the declared-length case receives 413, while the chunked case finishes a server-side 413 with requestDestroyed=true and receives ECONNRESET. No child command is invoked.

The uncommitted-WAL migration test hashes the SHM file while SQLite holds a write transaction. Windows byte-range locking rejects that read with EBUSY before migration runs. The migration implementation explicitly supports offline/quiescent snapshots, not live writer backups, and must retain its source-byte verification.

## Decision

The body reader uses IncomingMessage.iterator({ destroyOnReturn: false }) so an intentional early limit rejection preserves the response transport. On 413, it writes the complete JSON error with an explicit Content-Length immediately, discards remaining request bytes without retaining them, and calls response.end only after the request ends. The extra finalization rule matters: preserving the iterator alone leaves requestDestroyed=false but still resets Windows clients when Node finishes a Connection:close response with unread upload bytes. Explicit response length lets the client finish reading 413 without waiting for its upload to end. The byte bound and JSON 413 contract remain unchanged; connection resets never count as successful responses. Tests exercise declared, streamed, and still-open streamed uploads against the real HTTP server and require the complete JSON error body with zero child calls.

The migration fixture forces an actual uncommitted transaction to spill pages into its WAL, then copies DB and WAL into a separate offline snapshot before rolling back the writer. It does not copy transient SHM coordination state. Assertions require WAL growth beyond its committed prefix, unchanged snapshot bytes, and recovery of the original committed project and every human page/proposal/archive. The separate committed-WAL test continues hashing DB/WAL/SHM bytes unchanged.

Incomplete oversized requests receive Connection: close so clients cannot reuse a connection whose rejected upload is still being discarded. The still-open upload regression explicitly requests keep-alive and requires the close response.

## Related note audit

- [Process integration](../architecture/2026-10-31-repo-wiki-process-integration.md): partially overlapping vendor verification scope; the standalone HTTP server is not part of the Electron product route.
- [Windows Git identity](./2026-10-31-repo-wiki-windows-git-identity.md): same vendor portability effort, independent scanner mechanism.
- Existing AgentData/codegraph WAL notes describe different databases and worker contracts; they do not constrain this copy-first migration.

## Alternatives considered

- Treat ECONNRESET as an acceptable oversized-request outcome: simple and would avoid transport changes, but contradicts the tested public 413 response and hides an actual runtime bug.
- Drain the entire oversized body before rejecting: preserves the iterator's normal completion, but delays rejection until an untrusted sender finishes and defeats the early-limit contract.
- Ignore locked SHM files or skip the migration test on Windows: avoids EBUSY, but weakens unchanged-source guarantees or leaves human-data recovery untested.
- Close/rollback SQLite before capturing its WAL: makes every source file readable, but removes the uncommitted frames the regression needs to exercise. A separate offline DB/WAL copy preserves those frames and matches the supported migration contract.

## Verification

Before the production edit, the two original targeted tests fail with EBUSY and ECONNRESET respectively. After the edit, `node --import tsx --test packages/core/tests/migration.test.ts packages/service/tests/http.test.ts` passes 20/20, including the offline uncommitted WAL and all three oversized upload variants. `node electron-agent/node_modules/typescript/bin/tsc -p .tmp-repowiki-source/portability.tsconfig.json --noEmit` passes with a temporary configuration restricted to the three changed files and their imports. `npm run verify-notes` passes; its six existing result-wording warnings are outside this change. Logs and the detailed report are under `.tmp-repowiki-source/portability-*`.

## Consequences

Windows clients receive the actual bounded-request error, and the WAL regression covers real uncommitted frames without weakening human-data or source-byte assertions. Leaving an iterator early without destroying its stream relies on Node's supported readable iterator API (the package requires Node >=22.13). An incomplete sender keeps its connection until it closes, completes, or reaches the server's existing request timeout; rejection does not buffer or parse more input, and the complete response is sent immediately. The offline test captures DB/WAL while no additional writer operation runs and makes no claim of hot migration support. The vendored subset has no standalone tsconfig.json, so its upstream build:core command is unavailable; the changed import closure is typechecked through the host toolchain instead.
