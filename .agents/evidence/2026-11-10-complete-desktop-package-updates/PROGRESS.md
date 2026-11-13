# D progress — complete-desktop-package-updates

Owner: implement_model_settings（D 独占执行 owner；A 已冻结移交 root）。
State: safe checkpoint; user/root scope decision pending, no further implementation now.
OpenSpec: 3/28 complete, 25 unchecked. Do not mark stage/CAS primitives as complete update orchestration.

Authoritative current handoff: CHECKPOINT.md. Initial baseline: HANDOFF.md.

Atomic source / tests saved: journal v2 runtime schema + pre-first-rename recovery (7 pass); narrow SettingsManager.fromStorage entry CAS / proper-lockfile protocol (3 pass); SDK isolated whole npm/git stage adapter (5 pass); static metadata (9 pass); native read-only counter fixture (1 pass); DTO / contract docs. No UI/IPC/apply/reload/startup recovery is wired.

User approved external boundary is already reconciled and strict validated: keep shared roots, explicit external Pi/CLI quiet precondition only for new upgrade/repair, app-owned consumers automatically guarded. No production Known=true fallback.

Next action belongs to root: decide whether D merits continuation this round. Wait for explicit resumption; do not expand UI/architecture/tests now.
