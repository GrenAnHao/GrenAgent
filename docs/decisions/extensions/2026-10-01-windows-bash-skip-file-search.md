---
title: Windows 的 bash 提示不再把列目录和搜文件交给 PowerShell
status: active
date: 2026-10-01
scope: extensions
files:
  - extensions/sandbox/windowsBashPrompt.ts
  - extensions/batch-tools/search.ts
  - extensions/fable-behavior/prompts/tier1/coding-harness.md
supersedes:
superseded_by:
---

## 背景
Windows 上 `bash` 实际跑的是 PowerShell。2026-09-15 的壳层规格把 `promptSnippet` 和工具说明改成 `Get-ChildItem`、`Select-String`、`Get-Content`，避免模型往 PowerShell 里写 POSIX。模型随后用这两条 cmdlet 列迁移目录、扫 SQL，每次都要启动 PowerShell，比内置的 `ls` / `grep` 和打包的 ripgrep `search` 慢。

## 决定
`bash` 的 Windows 提示只保留语法约束：PowerShell、用 `;` 串联、原生命令结尾写 `; exit $LASTEXITCODE`、不要把 POSIX `ls` / `grep` / `find` / `&&` 传给 `bash`。列目录、按路径找文件、搜文件内容、读文件分别指向 `ls`、`find`、`grep` 或 `search`、`read`。

## 放弃的方案
- 继续在 snippet 里举例 cmdlet，只在行为核里补一句「优先专用工具」：Available tools 里的示例比那句更具体，模型会跟着示例走。
- 从 Plan / Ask 的只读白名单删掉这些 cmdlet：模型已经选错之后才会被拦住，多一轮失败调用，不减少 PowerShell 启动。
- 在 `bash` 执行层把 `Select-String` 改写成 ripgrep：调用仍然要起 PowerShell，而且把错误选择藏进执行器。

## 后果
模型若仍把 `grep` 当 shell 命令传给 `bash`，PowerShell 会失败；提示里同时写了「用 grep 工具」和「不要把 grep 传给 bash」。Plan / Ask 的只读白名单仍放行这些 cmdlet，避免偶发调用被安全闸误杀。
