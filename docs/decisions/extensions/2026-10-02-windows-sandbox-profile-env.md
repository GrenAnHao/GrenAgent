> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: Windows 沙箱环境变量改用 PiSandbox 自己的主目录
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/windows/helper.c
  - extensions/_shared/sandbox/windows/launch.c
  - extensions/_shared/sandbox/windows/account.ts
  - extensions/_shared/sandbox/windows/runner.ts
supersedes:
superseded_by:
---

## 背景
账户启动会把调用方的环境整份复制给沙箱进程，只改 `TEMP`/`TMP`/`TMPDIR`。复制结果仍是登录用户：`USERNAME` 为 rxstudio，`USERPROFILE` 为 `C:\Users\rxstudio`，`TEMP` 落在该用户 `AppData\Local\Temp\pi-sandbox\<uuid>`。令牌身份是 PiSandbox，这个主目录和临时目录都不可写。`os.homedir()` 跟着 `USERPROFILE` 走，所以家目录和临时目录一起失败。

## 决定
`--sandbox-home` 传入 `C:\Users\PiSandbox`。helper 在复制环境时改写 `USERNAME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`TMPDIR`，`TEMP` 为该主目录下的 `AppData\Local\Temp`。`PATH` 仍来自调用方，这样能找到 node。启动器在跑命令前把这些目录建出来。

## 放弃的方案
- 继续把 `TEMP` 放在登录用户的 `pi-sandbox\<uuid>` 下并补写权限：父目录不可创建子项，叶子从未出现，而且家目录仍然指错人。
- 保留登录用户的环境，只把 `Documents` 等子目录授权给 PiSandbox：那是在别人的配置目录上开口，工具仍会读到错误的 `.npmrc` / `.gitconfig`。

## 后果
沙箱里的家目录和临时目录属于 PiSandbox，不再是当前登录用户。第一次 `LOGON_WITH_PROFILE` 会创建该配置文件。调用方的 `PATH` 被保留，profile 专用变量不会。
