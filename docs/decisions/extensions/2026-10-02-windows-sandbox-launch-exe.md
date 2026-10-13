> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: Windows 沙箱用无控制台启动器换账户
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/helper.c
  - extensions/_shared/sandbox/windows/launch.c
supersedes: extensions/2026-10-02-windows-sandbox-no-console.md
superseded_by:
---

## 背景
专用账户 `PiSandbox` 仍然是 Windows 沙箱的启动身份。`CreateProcessWithTokenW` 在这个进程里返回 1314（`ERROR_PRIVILEGE_NOT_HELD`）：交互用户没有 `SeImpersonatePrivilege`，命令不会启动。`CreateProcessWithLogonW` 不需要这项特权，但它拒绝 `CREATE_NO_WINDOW`，直接启动 PowerShell 会弹出控制台。

## 决定
helper 用 `CreateProcessWithLogonW` 启动旁边的 `pi-sandbox-launch.exe`。这个 exe 是 Windows 子系统，自己没有控制台。它再以 `CREATE_NO_WINDOW` 启动真正的命令，并继承标准输入输出。账户、DPAPI 密码和目录授权不变。

## 放弃的方案
- 继续 `CreateProcessWithTokenW`：1314，命令起不来。
- `CreateProcessWithLogonW` 直接启动 PowerShell，只加 `SW_HIDE`：控制台子系统仍会先建窗口。
- 用 SYSTEM 服务做 `CreateProcessAsUserW`：能藏窗口，但要常驻服务和安装步骤。

## 后果
`pi-sandbox-launch.exe` 必须和 `pi-sandbox-win.exe` 放在同一目录，打包时一起 unpack。缺了它，helper 以 163 退出，命令不会执行。
