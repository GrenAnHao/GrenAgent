> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md](../../../.agents/notes/implemented/architecture/2026-10-02-windows-sandbox-pisandbox-account.md) 维护；本文件冻结只读。

---
title: 长命令写入临时脚本文件，绕开 CreateProcessWithLogonW 的字符上限
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/_shared/sandbox/operations.ts
  - extensions/_shared/sandbox/windows/helper.c
supersedes:
superseded_by:
---

## 背景
`CreateProcessWithLogonW` 的 `lpCommandLine` 参数通过 Secondary Logon Service（seclogon）的 RPC 通道传输，受约 1024 宽字符的内部缓冲限制。`pi-sandbox-launch.exe` 路径、shell 标志和 `PS_UTF8_PREFIX` 消耗约 450 字符，留给用户命令的空间只剩约 580 字符。多行脚本、内联 `node -e`、中文提示词很容易超过这个上限。超过后 `CreateProcessWithLogonW` 返回 `E_INVALIDARG`（0x80070057），此前被误判为间歇性故障。

## 决定
当用户命令超过 400 字符时，`operations.ts` 将 `PS_UTF8_PREFIX` + 命令体写入沙箱临时目录下的 `.ps1` 文件（带 UTF-8 BOM），shell argv 改用 `-File <path>` 替代 `-Command <inline>`。`lpCommandLine` 因此固定在约 250 字符以内，与命令长度无关。`helper.c` 增加预检：`wrapped` 超过 1000 字符时直接报明确的长度错误并退出，不再盲目重试。

## 放弃的方案
- 把命令通过 stdin 管道传入 `pwsh -Command -`：当前 spawn 设置使用 `stdio: ["ignore"]`，改动影响面大，且与 `CreateProcessWithLogonW` 的句柄继承配合复杂。
- 在 C 侧（helper.c）写临时文件：helper 以调用者身份运行，PiSandbox 不一定有读取权；跨用户文件权限增加额外配置。
- 只把缓冲区调大：`CreateProcessWithLogonW` 的限制在 seclogon 服务内，调用者无法改变。

## 后果
命令体无实际长度限制（仅受文件系统约束）。脚本文件由 24 小时 TTL 扫描清理。`-File` 模式与 `-Command` 模式在退出码语义上有细微差异（`$LASTEXITCODE` 传播规则），目前场景下无影响；如果将来出现差异，可改为 `-Command "& '<path>'"`。
