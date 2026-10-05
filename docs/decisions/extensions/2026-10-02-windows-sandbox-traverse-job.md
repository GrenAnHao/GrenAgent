---
title: Windows 沙箱补祖先遍历、工作目录和进程树回收
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/account.ts
  - extensions/_shared/sandbox/windows/helper.c
supersedes:
superseded_by:
---

> `C:\Windows\Temp` 不授列出权这一条已过时 → 见 [2026-10-02-windows-sandbox-temp-findfirst.md](2026-10-02-windows-sandbox-temp-findfirst.md)

## 背景
专用账户能跑子进程之后，实测还有几处对不齐。工作区在 `C:\Users\<user>\.pi\agent\works\<id>` 下，祖先目录拒绝 `lstat`，node 的 `realpath` 因此无法执行工作区内的脚本。`TEMP` 指到用户 Temp 下的 `pi-sandbox\<id>`，父目录同样不可遍历，写入得到 EPERM 而不是 ENOENT。`CreateProcessWithLogonW` 的 `lpCurrentDirectory` 传了 NULL，新登录的默认目录是 `C:\Windows\System32`。命令结束后 detached 子进程还在。

## 决定
给工作区和临时目录的每个祖先目录只授 `FILE_READ_ATTRIBUTES | FILE_TRAVERSE`（icacls `(RA,X)`，不继承、不传播）。不授列出和读取内容的权限。临时目录本身仍授 Modify，并且 helper 把当前目录（operations 设成会话工作区）传给 `CreateProcessWithLogonW`。启动器进程放进带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、不允许 breakaway 的 Job；helper 在读完退出码后关闭 Job，回收还活着的后代。`CreateProcessWithLogonW` 遇到 `ERROR_INVALID_PARAMETER` 时最多再试两次。

## 放弃的方案
- 把祖先目录改成可列出、可读：`.pi` 和用户配置文件的内容会暴露给沙箱账户。清单里这些拒绝是设计如此。
- 把 `TEMP` 挪到 `C:\Windows\Temp`：那边对 Users 可写，但列目录和按枚举删除并不稳定，scratch 文件会和系统临时文件混在一起。
- 给 `C:\Windows\Temp` 补列出权限，让 `Remove-Item` 和 `cmd del` 与 `DeleteFile` 一致：那个目录的 ACL 本来就是「可创建、不可列出」。`FindFirstFile` 失败时 cmd 报 Could Not Find，PowerShell 报拒绝访问；`DeleteFile` / `File.Delete` 按完整路径仍能删。补列出权限会让沙箱读到别人的临时文件。

## 后果
祖先目录可以被 `lstat`，不能被 `readdir`。`node <工作区内脚本>` 不再因为 `.pi` 不可 stat 而失败。`TEMP` 仍在用户 Temp 下的 `pi-sandbox` 目录，但祖先可遍历且目录已创建。Job 收不进去时命令照样跑，stderr 留下 `AssignProcessToJobObject` 的错误码，detached 进程可能残留。`C:\Windows\Temp` 上四条删除路径仍然不一致，这是该目录的 ACL，不是 cmdlet 策略。
