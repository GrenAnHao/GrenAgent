> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: Windows Temp 的列出权必须看到 ACL 才算授上
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/account.ts
supersedes: extensions/2026-10-02-windows-sandbox-temp-list.md
superseded_by:
---

## 背景
`C:\Windows\Temp` 对 Users 是可建文件、不可列出。PowerShell 7 的 `Remove-Item` 在 `RemoveItemCommand.ProcessRecord` 里调用 `IsReparsePointLikeSymlink`，后者对完整路径做 `FindFirstFile`。父目录没有 `FILE_LIST_DIRECTORY` 时，这个调用返回 Win32 错误 5，文件还在。`cmd del` 同样走 `FindFirstFile`，于是报找不到。node `unlink` 和 `File.Delete` 走 `DeleteFileW`，创建者对文件有完全控制，所以能删。`readdir` 走 `NtQueryDirectoryFile`，同样因没有列出权而 EPERM。上一轮把 `grants.json` 记成了 `RD`，但提权后的 `Start-Process -Verb RunAs` 拿不到子进程退出码，`exit $null` 被当成 0，ACE 实际没写上。

## 决定
仍只加 `(S,RD,RA)`，不追加写权限，也不继承。提权脚本把 `icacls` 的目录 ACL 写到日志里，日志里能看到 `PiSandbox` 的列出权才把缓存写成 `RD1`。旧的 `RD` 记录不算数。祖先目录的 `(RA,X)`、工作目录和 Job 回收不变。

## 放弃的方案
- 相信 `Start-Process -Verb RunAs -PassThru` 的 `ExitCode`：它经常是 null，null 被当成成功，授权被跳过。
- 每次命令都重新提权：用户会反复看到 UAC，而且上次就是这样把失败记成了成功。
- 改授修改权限：Users 本来就能建文件，多出来的写权限盖不住 `FindFirstFile` 失败。

## 后果
`PiSandbox` 可以列出 `C:\Windows\Temp` 里的文件名。这是让 `readdir`、`Remove-Item` 和 `cmd del` 与 `DeleteFileW` 一致的最小权利。确认失败时不写入缓存，五分钟内不重复弹出 UAC。
