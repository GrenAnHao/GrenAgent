# Agent Note: Repo Wiki 扫描尊重用户的 Git safe.directory

Status: implemented

## Problem

在 `D:\System Dir\Downloads\note-pocock-flow` 点「生成文档」后，任务在「准备源码」阶段失败，界面只显示 `GIT_PROBE_FAILED`。仓库的 `.git` 属于沙箱用户 PiSandbox，当前用户是 rxstudio；Git 因此报 `detected dubious ownership`。用户全局配置里有 `safe.directory = *`，普通 `git` 命令可用，但扫描器为隔离仓库配置设置了 `GIT_CONFIG_GLOBAL=NUL`，把这条信任一起关掉了。同一进程里 `projectPort` 的分支探测不隔离全局配置，两边身份会不一致。

## Decision

`scanner.ts` 新增 `userSafeDirectoryArgs()`：用用户正常环境读 `git config --global --get-all safe.directory`，缓存 30 秒，把每条以 `-c safe.directory=<值>` 传给扫描用的所有 git 调用（同步、异步和仓库探测）。只转发用户自己做的信任决定，其余全局配置继续隔离；`core.fsmonitor` 与 hooks 仍被禁用。探测遇到 dubious ownership 时返回 `GIT_DUBIOUS_OWNERSHIP`，界面翻译成可操作的说明。

## Alternatives considered

- 扫描时固定传 `safe.directory=*`：最省事；不采用，等于替用户放开所有其他账户的仓库，越过 Git 的所有权保护。
- 不隔离全局配置：与普通 git 行为一致；不采用，全局配置可能带 fsmonitor、外部 diff 等会执行程序的设置，扫描需要可预期的只读行为（见 [Windows Git 身份](2026-10-31-repo-wiki-windows-git-identity.md)）。

## 验证

- 真实仓库：`pnpm exec tsx probe-scan.mts` 对 `D:\System Dir\Downloads\note-pocock-flow` 返回 `git.kind=git`、分支 `master`、173 个文件、覆盖完整；修复前同命令为 `kind=error`。
- `node --import tsx --test vendor/repo-wiki/packages/core/tests/scanner-safe-directory.test.ts`：1 项通过。
- `pnpm run test:repo-wiki`：238 项通过。

## Consequences

用户之后新增的 safe.directory 最多 30 秒后生效。没有任何信任条目时行为与以前相同，仍由 Git 拒绝其他账户的仓库，并提示用户自行信任。
