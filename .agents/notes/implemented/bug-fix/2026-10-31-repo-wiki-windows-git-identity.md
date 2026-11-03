# Agent Note: Repo Wiki Windows Git 身份探测

Status: implemented

## Problem

v3 原始 scanner 把 `os.devNull` 同时传给 Git 的配置文件与 hooksPath。Windows Node 返回 `\\.\nul`，本机 Git 报 `unable to access ...: Invalid argument`。scanner 的错误回退把正常 Git 项目标成 local，导致分支间 Wiki 与卡片命名空间混用，语言和提交身份测试也受影响。

## Decision

Windows 用 Git 接受的 `NUL`，其他平台继续使用 `os.devNull`。保留禁止全局/系统配置、hooks 与 fsmonitor 的限制，Git 子进程保持隐藏窗口。已有 scanner、engine 和 cards 分支隔离测试作为行为回归。

## Alternatives considered

- 移除隔离的 Git 配置环境变量可以恢复分支识别；不用，因为会重新加载用户配置并可能执行 fsmonitor 等外部命令。
- 手动解析 .git/HEAD 不需要启动 Git；不用，因为还需覆盖 worktree、detached HEAD、提交身份与索引，超出这个已定位问题的最小修复范围。

## Behavior

隔离配置下 Git 正常返回当前分支；scanner 的 branch-sensitive 测试及 Wiki/cards 分支隔离测试通过；禁止 hooks/filters 的断言仍通过。

## 验证

修复前已复现：os.devNull 为 `\\.\nul` 时退出码 128；改用 NUL 的同一只读命令退出码 0。`branch and language card collections` 回归测试修复前失败（2 !== 0）。修复后 scanner 分支身份、engine 分支/提交隔离、core/service 卡片分支隔离测试均通过；真实 Electron child 的持久化、取消与崩溃恢复工作流也通过。证据见 `.agents/evidence/2026-10-31-repo-wiki-process-integration/electron-child-tests.log` 和 [进程接入](../architecture/2026-10-31-repo-wiki-process-integration.md) 的最终回归记录。

## Consequences

此修复保留 Git 身份格式、命名空间和禁用配置/外部命令的限制；Windows 恢复正确分支识别，非 Windows 继续使用 os.devNull。Git 仍是仓库身份的外部依赖。
