# Pi SDK 1.4.0 installation patches

## 1.3.0 baseline

- `patches-baseline-1.3.json` and `.log` record real paths, SHA-256 hashes and actual `generateDiffString()` output for all three installed copies.
- CLI and extensions have the local shell patch and five context lines; Electron has the upstream shell and four context lines. The package copies are separate pnpm directories.
- Only CLI has a patch postinstall hook. Existing scripts always target CLI regardless of caller directory; no committed patch tests were found.
- The 1.3 shell helper marker is insufficient: generic `findExecutableOnPath()` still calls bare `where`; only Git-derived Bash uses the helper. No baseline success claim is based on this marker.

## Official 1.4.0 changes inspected

Source: https://raw.githubusercontent.com/badlogic/pi-mono/v1.4.0/packages/coding-agent/src/utils/shell.ts

- Upstream replaces `existsSync` with `shellPathExists()` using `accessSync`, preserving runnable Windows Store aliases; validates WSL launcher paths relative to SystemRoot; and adds PowerShell installation-directory fallbacks.
- Upstream still uses bare `where`, process PATH only, and has no nonstandard Git installation lookup. Those local requirements remain. The patch must preserve upstream `shellPathExists()` rather than reintroduce `existsSync`.
- Each package postinstall invokes the same CLI-owned scripts with its own project directory; script default remains CLI for existing invocation compatibility. Parent owns the package.json wiring and locks.
- Historical note audit: `.agents/notes/implemented/architecture/2026-10-14-windows-bash-git-bash-like-pi.md` rejects custom Git discovery and documents explicit `shellPath` as the solution, whereas the existing CLI/extensions patch already implements Git discovery. Parent decided to retain the existing narrow lookup enhancement across the three entries and document this partial adjustment in the upgrade note. Portable Git, PowerShell in place of bash, sandbox policy changes and other shell strategies remain outside scope.
- `generateDiffString()` still defaults to four upstream context lines, so the five-line display preference remains a local patch. `generateUnifiedPatch()` retains four lines; it was already present in the saved 1.3 baseline, not newly introduced by this upgrade. Patched edit-diff.js is byte-identical between the 1.3 CLI baseline and 1.4.

## Changed files

- `cli/scripts/patch-pi-shell.mjs`: optional project root (default CLI), trusted absolute where.exe, registry PATH supplement and nondefault Git Bash lookup; retain SDK 1.4 accessSync/Store alias, WSL and PowerShell behavior. Reject unexpected or obsolete partial patch shapes before writing. Conventional Windows fallback uses `C:/Windows` to avoid JavaScript string escaping ambiguity.
- `cli/scripts/patch-pi-edit-preview.mjs`: optional project root; only display-diff default changes 4 to 5.
- `cli/src/pi-install-patches.test.ts`: fresh fixtures reconstructed from the official source maps, with independent package directories. Runs the actual patch scripts and resulting upstream functions, replacing only OS filesystem/process boundaries for deterministic shell cases. Actual Diff implementation is used.

## TDD and focused verification

- Initial RED: `cd cli; node --import tsx --test src/pi-install-patches.test.ts`, `patches-red.log`: 5 passed, 5 failed. Reproduced ignored extensions/Electron target, nondefault Git/MSYS lookup failure and obsolete helper-marker false success.
- Initial GREEN: same command, `patches-green.log`: 10 passed, 0 failed.
- Production-bytecode inspection revealed the initially generated missing-SystemRoot fallback contained a single backslash in a string literal. Added the missing-environment regression: `patches-fallback-red.log`: 1 failed with no bash found. Changed the fallback to `C:/Windows`, reapplied the correction to installed files (`patches-reapply-fixed.log`).
- Final GREEN: same full focused command, `patches-green-final.log`: **11 passed, 0 failed**, exit 0. Covers three explicit target roots, old no-argument invocation, five-line display vs four-line unified patch, nondefault Git, non-Git MSYS, absent SystemRoot/WINDIR, Store alias/WSL/PowerShell 7 preservation, byte-idempotence, unknown shapes and incomplete old markers.
- `git diff --check -- cli/scripts/patch-pi-shell.mjs cli/scripts/patch-pi-edit-preview.mjs cli/src/pi-install-patches.test.ts`: exit 0.

## Actual installed package behavior

- Parent installed all three official exact 1.4.0 packages with lifecycle scripts ignored. This agent performed no dependency installation, manifest or lock modification.
- Applied the shared scripts to each root (`patches-apply-installed.log`), then ran **each package's actual `npm run postinstall`** successfully: `patches-postinstall-idempotent.log`, all exit 0. Final corrected fallback is reapplied to all targets in `patches-reapply-fixed.log`; **all three actual postinstall commands ran again after the correction**, exit 0 (`patches-postinstall-final.log`).
- `node .tmp-pi-sdk-1.4/patches-verify-installed.mjs`: each installed 1.4 package runs actual `generateDiffString` (five lines around line 11) and `generateUnifiedPatch` (four lines, hunk `@@ -7,9 +7,9 @@`). Results are in `patches-installed-1.4.json` and `patches-installed-1.4-final.log`.
- The same verifier launches an isolated Node child with **empty PATH**, no credential variables and only Windows installation/temp variables. Each actual SDK resolves `D:\Kits\Git\bin\bash.exe`, starts that bash with a fixed `printf` command and gets exactly `pi-sdk-1.4-patch-ok`; PowerShell resolver returns the runnable WindowsApps pwsh alias. No model calls or application startup.
- First command-sandbox attempt failed after successful Git Bash resolution at MSYS `NtCreateDirectoryObject(...): 0xC0000022` (`patches-installed-1.4.log`). The same verifier outside the command sandbox was auto-approved and passed (`patches-installed-1.4-unsandboxed.log`), then passed again after the fallback fix (`patches-installed-1.4-final.log`). No sandbox/security setting was changed.
- Final actual files in all three package roots have identical hashes:
  - shell.js SHA-256: `592e7d3bda71c617f93218d977a5c229d0849347ab23246f0a459e67c81627af`
  - edit-diff.js SHA-256: `9bccf8c6394b8d6aa8782c10884c876890de9d2e4c90725cff61789f81b781f7`
- All three 1.4 package roots resolve separately but shell.js shares the same hard-linked file inode. The independent fresh fixtures above verify reproduction without relying on that sharing.

## Scope and final production-resource check

- An additional `npm test` was started just before the parent said not to expand CLI coverage and was interrupted immediately. `patches-cli-full.log` is **incomplete, not an acceptance result**; its captured output includes the existing missing-vitest/node:test issue in `src/agent-data-plugins.test.ts`. No unrelated test or package-manager change was made.
- Parent's first localrun/production builds passed before the final fallback correction. Production bytecode inspection located the actual shell implementation in `electron-agent/out-pkg/main/chunks/armin-46QgvXtV.jsc` and exposed the escaping problem. Parent rebuilt after the correction.
- Final production-resource checker exited 0 (`patches-production-resources.log` / `.json`). Exactly one actual SDK shell bytecode implementation appears in `electron-agent/out-pkg/main/chunks/armin-ubs4djsZ.jsc`, SHA-256 `1f78dfc44e1a0dde1e31b8e2ded648b4f76a637f8d0f19387508004e6aea2b6d`; it contains the corrected `C:/Windows` literal and no broken `C:Windows` literal. Entry stubs/bytecode, bytecode loader, commonjs package.json, runner.py/mjs, guard/sandbox helpers, prompts/texts/ultra rules exist at the actual output paths, including the adjacent chunks copies. Bytecode string presence is only resource/build inclusion evidence; the installed SDK execution results above supply independent behavior evidence. No production app was started.
