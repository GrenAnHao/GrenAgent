> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: Windows 沙箱账户启动时不弹出控制台
status: superseded
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/helper.c
supersedes: extensions/2026-10-02-windows-sandbox-account.md
superseded_by: extensions/2026-10-02-windows-sandbox-launch-exe.md
---

> 已过时 → 见 [2026-10-02-windows-sandbox-launch-exe.md](2026-10-02-windows-sandbox-launch-exe.md)

## 背景
专用账户 `PiSandbox` 仍是 Windows 沙箱的启动身份。`CreateProcessWithLogonW` 会在新的窗口站上给控制台程序开一个可见窗口，而且它不接受 `CREATE_NO_WINDOW`。

## 决定
helper 先 `LogonUserW`，再 `CreateProcessWithTokenW`，创建标志带 `CREATE_NO_WINDOW`，启动信息里再把窗口设为隐藏。调用进程打开 `SeImpersonatePrivilege`。账户、DPAPI 密码和目录授权不变。

## 放弃的方案
- 继续用 `CreateProcessWithLogonW`，只加 `SW_HIDE`：这个 API 拒绝 `CREATE_NO_WINDOW`，控制台子系统仍会先建窗口。
- 改回 `CreateProcessAsUserW` 加 `CREATE_NO_WINDOW`：当前用户进程没有 `SeAssignPrimaryTokenPrivilege`，这条路是 Codex 服务进程才走得通的。

## 后果
交互式登录的用户进程可以无窗口启动沙箱命令。没有 `SeImpersonatePrivilege` 的调用方会在 `CreateProcessWithTokenW` 失败，helper 以 163 退出，命令不会执行。
