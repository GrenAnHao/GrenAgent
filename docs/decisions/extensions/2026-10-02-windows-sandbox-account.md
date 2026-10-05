---
title: Windows 沙箱改为专用本地账户启动
status: superseded
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/helper.c
  - extensions/_shared/sandbox/windows/account.ts
  - extensions/_shared/sandbox/provider.ts
supersedes:
superseded_by: extensions/2026-10-02-windows-sandbox-no-console.md
---

> 已过时 → 见 [2026-10-02-windows-sandbox-no-console.md](2026-10-02-windows-sandbox-no-console.md)

## 背景
Windows 沙箱用当前用户的 `WRITE_RESTRICTED` 令牌。libuv 的 `stdio: 'pipe'` 走命名管道，管道默认安全描述符只给 Everyone 读、给所有者写，而所有者（当前用户）不在 restricting SID 里。`node --test`、`vitest`、`tsx` 因此得到 `EPERM`。令牌默认 DACL 只覆盖匿名管道，覆盖不了这条路径。

## 决定
工作区沙箱在 Windows 上改为 `CreateProcessWithLogonW`，以专用本地账户 `PiSandbox` 启动命令。该账户的 SID 就是管道所有者，命名管道的写检查可以通过。工作区和会话临时目录用 icacls 授予该账户；用户配置文件下的 PATH 目录只授执行。账户第一次创建需要一次提权。密码用 DPAPI 存在当前用户的 `~/.pi/sandbox/account.bin`，不进命令行。

## 放弃的方案
- 在受限进程里挂钩 `CreateNamedPipeW`：要给每个孙进程注入 DLL，比换账户更脆。
- 把当前用户 SID 加进 restricting SID：写检查会在用户能写的任何路径上通过，工作区边界没了。
- 照搬 Codex 的 Windows 服务：服务能做同样的 `CreateProcessAsUser`，但 Pi 的 helper 已经在用户进程里，`CreateProcessWithLogonW` 不需要常驻 SYSTEM 服务。
- 继续用当前用户的写限制令牌，测试靠升到完全权限：工作区档仍然跑不了测试。

## 后果
没有批准过账户创建时，Windows 沙箱不可用，命令不会退回旧令牌。`PiSandbox` 仍是 `Users` 组成员，能写自己的配置文件和系统里本就对 Users 可写的目录；工作区以外的用户文件没有 ACE，写不了。读限制仍然没有。helper 必须用带 `crypt32` 的新二进制，旧的 `pi-sandbox-win.exe` 不认 `--logon-user`。
