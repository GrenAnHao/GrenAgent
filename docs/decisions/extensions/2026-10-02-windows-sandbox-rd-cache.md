> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: 不缓存 C:\Windows\Temp 的列出权 ACL 授予
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/account.ts
supersedes:
superseded_by:
---

## 背景
`grantSandboxAccess` 把所有 ACL 授予记录在 `~/.pi/sandbox/grants.json` 中。`C:\Windows\Temp` 的 `(S,RD)` 授予也被缓存后，如果系统通过 Windows Update、组策略或修复操作重置了该目录的 ACL，下次启动沙箱时缓存显示"已授予"而跳过实际 `icacls`，导致 `Remove-Item` 和 `readdirSync` 继续失败（缺陷 5 和 7 的复现）。

## 决定
对 `RD` 权限类型的 target 跳过缓存检查，每次都重新执行 `icacls`。`RD` 授予只用于 `C:\Windows\Temp` 一个目录，且需要 UAC 提权——`elevateIcacls` 已保证同一进程内最多弹出一次 UAC 对话框。

## 放弃的方案
- 在授予后用 `readdirSync` 验证再决定是否缓存：需要以 PiSandbox 身份运行验证脚本，增加复杂度。
- 完全不再使用 `C:\Windows\Temp`：`TEMP` 已改指 PiSandbox 的 profile，但第三方工具可能硬编码 `C:\Windows\Temp` 为后备路径，放弃授予会让那些工具在枚举和删除时失败。

## 后果
每个 agent 进程首次启动沙箱时会尝试一次 unelevated `icacls`（约 100ms），失败后尝试一次 UAC 提权。如果用户取消 UAC，授予静默跳过（已有 `continue` 兜底），不阻塞命令执行。
