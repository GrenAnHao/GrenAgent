> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: 给 PiSandbox 补上 Windows Temp 的列出权，让删除路径一致
status: superseded
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/account.ts
  - extensions/_shared/sandbox/windows/deleteSemantics.test.ts
supersedes:
superseded_by: extensions/2026-10-02-windows-sandbox-temp-findfirst.md
---

> 已过时 → 见 [2026-10-02-windows-sandbox-temp-findfirst.md](2026-10-02-windows-sandbox-temp-findfirst.md)

## 背景
`C:\Windows\Temp` 对 Users 是可新建文件、不可列出。文件的创建者仍有 `DELETE`，所以 `DeleteFileW`（node `unlink`、`.NET File.Delete`、Windows PowerShell 5.1 的 `Remove-Item`）能删掉。PowerShell 7 的 `Remove-Item` 和 `cmd del` 会先对父目录做 `FindFirstFile`：前者报拒绝访问，后者报找不到，文件都留着。在私有目录上收成 `(S,WD,AD,X)` 加 `CREATOR OWNER` 完全控制后，结果与沙箱里的实测一致。补上 `(S,RD)` 之后四条路径都能删。

## 决定
给 PiSandbox 增加该目录本身的 `(S,RD)`，不继承、不追加写权限。`FindFirstFile` 因此能看见文件，`Remove-Item` 和 `cmd del` 与 `DeleteFileW` 一样能删掉它。当前用户改不了这个 ACL 时，同一次进程里只弹出一次 UAC 去执行 `icacls`。

## 放弃的方案
- 再授一份写或修改权限：Users 本来就能建文件，多出来的写权限盖不住“列出失败”，也扩大了共享临时目录上的权限。
- 只授 `RD`、不带 `S`：单独的列出权不够，`dir` 仍然失败；同步权要和列出权在一起，`FindFirstFile` 才成功。
- 改 cmd / PowerShell：这两条路径在系统里，沙箱碰不到。

## 后果
PiSandbox 可以列出 `C:\Windows\Temp` 里的文件名。这是让删除结果一致的最小权利。授权失败不会建议用户改成完全权限；下一条命令不会再次弹出 UAC。
