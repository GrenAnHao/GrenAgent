# Repo Wiki source

Imported from the user-approved TypeScript / Node.js v3 archive on 2026-10-31.

- Archive: `Gren_RepoWiki_TypeScript_Electron.zip`
- SHA256: `899862f29c20f402e379dcab35bc2fa603f61aa4e3c52e1e015a47ac4c7988b5`
- Library identity: `libfile_2839c060dfb4819185d326f9ac3bc6cd`, version `3`
- License: MIT (see `LICENSE`); dependency notices: `THIRD_PARTY_NOTICES.md`

`packages/` contains the contracts, isolated service, supervisor and adapters.
`apps/web/src/` contains the approved embeddable panel. The standalone HTTP/demo
entry is not started by GrenAgent. Runtime dependencies are owned by the host
`electron-agent/package.json`; this vendored package is not installed separately.

Host integration uses `src/features/repoWiki/`, `electron/app/repoWikiService.ts`
and the host Electron build. See `docs/GRENAGENT_INTEGRATION.md` for the upstream
contract and `.agents/notes/` in the repository root for the integration decision.
