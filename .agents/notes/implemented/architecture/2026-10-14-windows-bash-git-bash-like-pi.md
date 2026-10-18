# Agent Note: Windows 上 bash 工具照 pi 用 Git Bash，不再走 PowerShell

Status: implemented

## Problem

工具叫 `bash`，Windows 上却一律交给 PowerShell 执行（原 `extensions/_shared/sandbox/shellPath.ts` 先找 `pwsh.exe`，找不到用 Windows PowerShell 5.1），提示词再教模型把命令写成 PowerShell 语法（`;` 串联、`; exit $LASTEXITCODE`、`Select-Object -Last`）。用户要求 bash 工具不再用 PowerShell，「看 Pi 官方的 bash 是怎么做的我们就怎么做」。

同时有一个直接的故障：沙箱里命令行超长，命令不执行。`CreateProcessWithLogonW` 的命令行上限约 1024 字符，`helper.c` 超过 1000 直接报 `command line too long`。PowerShell 前缀 `PS_UTF8_PREFIX` 499 字符 + cwd 守卫 30 字符 + 启动器 / pwsh 路径和参数，固定开销约 685（dev）到 720（安装目录）字符；改走 `.ps1` 文件的门槛却只看用户命令 `command.length > 400`。用户命令 280～400 字符、或者引号多一点，就撞上限（2026-10-14 实际撞到 1025 字符）。

2026-09-15 选 PowerShell 的理由（冻结的 `docs/superpowers/specs/2026-09-15-windows-powershell-shell-design.md` §1）是 Git Bash 在当时的沙箱令牌（WRITE_RESTRICTED，带 restricting SID）下起不来（`couldn't create signal pipe, Win32 error 5`）。2026-10-13 起沙箱令牌只把 Authenticated Users 设成 deny-only、不加 restricting SID（[受限令牌](2026-10-13-windows-sandbox-restricted-token-authenticated-users.md)），这条理由一直没重测。2026-10-14 在当前沙箱（PiSandbox 账户 + 受限令牌 + job）里实测 Git for Windows 的 `bin\bash.exe` 和 `usr\bin\bash.exe`：都能启动，中文输出、cwd、管道、后台 `&` + `wait`、退出码透传都正常，工作区外写入报 `Permission denied`、文件没建出来。

pi 自己的 bash 工具（`@earendil-works/pi-coding-agent` 的 `utils/shell.js` `getShellConfig` 与 `core/tools/bash.js`）：

- 解析顺序：settings.json 的 `shellPath` → `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe` → `where bash.exe` 的第一个结果（WSL 的 `System32\bash.exe` 时命令改走 stdin、参数 `-s`）→ 报错并给出安装说明。永远 `[shell, -c, command]`，不退回 PowerShell。
- 工具描述、`promptSnippet`（`Execute bash commands (ls, grep, find, etc.)`）各平台一样，没有 Windows 专门的说明。
- PowerShell 是单独的 `powershell` 工具，默认不启用（默认工具是 read / bash / edit / write）。
- 停止用 `taskkill /F /T`。

本机的 `~/.pi/agent/settings.json` 已经设了 `shellPath = D:\Kits\Git\bin\bash.exe`。

## Decision

### 壳：直接用 pi 的 getShellConfig

- `extensions/_shared/sandbox/shellPath.ts` 的 `resolveBashShell(shellPath)` 就是 pi 的 `getShellConfig`（按需动态加载 pi 包，sandbox 共享模块本身不带上整个 SDK），返回 `{ shell, args, commandTransport? }`。
- `extensions/sandbox/index.ts` 在 `session_start` 用 `SettingsManager.create(cwd, getAgentDir()).getShellPath()` 读 `shellPath`（pi 也是建会话工具时读一次），经 `shellPath` 依赖交给 operations。operations 按这个值缓存解析结果，值变了重新解析，起不来就丢掉缓存。
- 找不到 bash 时命令不执行，`runnerFailed: "unavailable"`，detail 是 pi 自己的报错（带安装说明）加 `The command was not executed.`。
- 工具描述照 pi：删掉 `annotateWindowsBashTool`（`windowsBashPrompt.ts`）和它给 Windows 加的 PowerShell 说明；`bashUiDescription.ts` 的流式提示只提 `tail` / `grep`；Fable 提示词、`default-agents.ts`、`search` 工具里的 PowerShell 写法和 cmdlet 名改成 bash 写法（`&&` 串联、路径用正斜杠或加引号）。

### 不受限运行（完全权限）

- argv 是 `[shell, -c, command]`；WSL 时 `[shell, -s]` 加 stdin，照 pi。
- Windows 上 Git Bash 的停止补一层：`taskkill /t` 按 Windows 父进程找子孙，msys 的 fork / exec 会把这条链断开，`sleep 300 &` 这类后台子进程停止后还活着（实测，pi 自己的 `killProcessTree` 一样）。msys 自己记着进程组：最外层的 bash 是组长，后台子进程跟它同组。所以命令前面同一行先把 `$$` 写进临时 pid 文件（路径经 `PI_BASH_PID_FILE` 带进去，写完就 `unset`），停止 / 超时时用同一个 bash 跑 `msysGroupKillScript`：反复 `kill -9 -- -<pgid>`，直到组里没人，再照旧 `taskkill /t /f`。
- 外层 `bin\bash.exe` 是包装，真正的 bash 是它拉起来的：停得太早时 taskkill 的快照里还没有这个 bash，它之后照样起来写 pid。停止后再盯 pid 文件约 3 秒（200ms × 15），晚到的 pid 再整组结束一次，盯完删文件；正常结束时直接删。

### 沙箱里（workspace-write / read-only）

- 去掉 `isWindowsBashExe` 拒绝和 `WINDOWS_BASH_UNAVAILABLE`。WSL 的 bash 仍然拒绝（没在受限令牌下验证过），提示把 `shellPath` 指到 Git Bash 或切到完全权限。
- 命令正文和工作目录经环境变量 `PI_BASH_COMMAND`、`PI_SANDBOX_CWD` 带进固定的引导脚本 `CONFINED_BASH_BOOTSTRAP`：先取出并删掉两个变量，`cd` 进工作目录，进不去就打印 `pi-sandbox-win: the sandbox account cannot open the working directory …; the command did not run` 并以 163 退出（runner 失败归因不变），然后 `eval` 命令。命令行长度和命令长度无关（约 300 字符），`command line too long` 不再出现；helper 的 1000 字符预检保留兜底。
- 删掉 `PS_UTF8_PREFIX`、PowerShell cwd 守卫（`PI_SANDBOX_CWD_GUARD` + `iex`）、`.ps1` 写文件那条路和 `WIN_COMMAND_FILE_THRESHOLD`；`env.ts` 的内部变量放行名单换成 `PI_BASH_COMMAND`、`PI_SANDBOX_CWD`。
- 受限环境去掉 `HOME`（不分大小写）：调用方的 `HOME` 指向登录用户的家目录，去掉后 msys 按令牌的账户取家目录。
- `windows/runner.ts` 的拒绝特征加上 `permission denied`（msys 的写法；原生程序是 `access is denied`）。仍要求退出码非 0 且出现在 stderr。
- 沙箱里的停止不变：helper 的 job（`KILL_ON_JOB_CLOSE`）随 taskkill 结束整棵进程树，msys 子进程也在里面（实测）。

`!` 用户命令（`user_bash`）走同一套 operations，一起换。终端面板（`shellService.ts`）和内部的 PowerShell 用途（提权、stat 探针、账户创建）不动。

### 涉及文件

- `extensions/_shared/sandbox/shellPath.ts`、`operations.ts`、`env.ts`、`windows/runner.ts`
- `extensions/sandbox/index.ts`、`bashUiDescription.ts`；删除 `windowsBashPrompt.ts`（及其测试）
- `extensions/fable-behavior/prompts/tier1/coding-harness.md`、`tier2/tool-discipline.md`、`tier2/terminal-harness.md`、`tier2/grep-strategy.md`，`extensions/fable-behavior/default-agents.ts`，`extensions/batch-tools/search.ts`
- 测试：`_shared/sandbox/shellPath.test.ts`、`operations.test.ts`、`isolation.live.test.ts`，`sandbox/index.test.ts`、`bashTool.test.ts`、`bashUiDescription.test.ts`
- 同步事实：`docs/architecture.md`、[cwd 守卫](../bug-fix/2026-10-13-windows-sandbox-shell-outside-workspace.md)、[PiSandbox 账户](2026-10-02-windows-sandbox-pisandbox-account.md)「长命令写 .ps1」一节标为已取代

## Alternatives considered

- **随应用自带裁剪版 PortableGit，一律用自带的 bash** — 最强论据：版本固定、行为一致，不依赖用户装没装 Git、装在哪；先这样做过：PortableGit 2.56.0.2（57 MB 下载，官方 SHA256 校验）解压 388 MB，裁掉 vim、文档、语言包、gitk / git-gui / tcl-tk 还剩约 292 MB，再去掉 Git Credential Manager 约 212 MB、再去掉 perl 约 173 MB。否决：用户看了体积和裁剪取舍后决定「自己打包 git 还是太麻烦了」，改为照 pi。MinGit（37 MB）更小但缺 `sleep`、`tee`、`chmod`、`ln`、`tar`、`which` 等常用命令，一开始就排除了。
- **保留 PowerShell，只修命令行长度（前缀挪进环境变量、按整条命令行长度决定是否写 `.ps1`）** — 最强论据：改动最小，PowerShell 的进程树 taskkill 停得干净。否决：用户明确要 bash 不走 PowerShell；模型按 bash 写的命令仍要被改写成 PowerShell。
- **自己写一套 Git Bash 查找（注册表 `GitForWindows\InstallPath`、`where git.exe` 推出 `bin\bash.exe`），不用 pi 的** — 最强论据：Git 装在非默认目录又没配 `shellPath` 时也能找到（本机 Git 在 `D:\Kits\Git`，`where bash.exe` 只有 WSL 启动器）。没选：用户要照 pi；pi 的 `shellPath` 设置正是给这种情况的，本机已经配了；自己加的查找会和 pi 的 `user_bash`、子代理里的 pi 行为不一致。
- **找不到 Git Bash 时退回 PowerShell** — 最强论据：总能执行。否决：pi 不退回；同一个工具两种语法，提示词要按运行时切换。
- **停止时只靠 taskkill（和 pi 一样）** — 最强论据：完全照 pi，代码最少。否决：实测 `sleep 300 & sleep 300; wait` 停止后两个 sleep 都还活着，正是用户抱怨的「停止不干净」。
- **不受限运行也放进 Job（复用 `pi-job-guard.exe` 或改 launcher 去掉受限令牌）** — 最强论据：Job 能收掉所有子孙，不依赖 msys。没选：Node 起不了挂起的进程，守卫在进程起来后才把它放进 Job，中间 fork 的子进程会漏；改 launcher 要动 C 代码和沙箱的启动路径。msys 进程组直接用 Git Bash 自带的 `kill`，不碰原生代码。
- **长命令写 `.sh` 文件再执行** — 最强论据：和原来 `.ps1` 一样直观。没选：要在工作区里落临时文件并清理；环境变量带入不落盘。

## Consequences

收益：

- Windows 上 bash 就是 Git Bash，模型按 POSIX 写命令；和 pi 自己的 bash、`user_bash` 一致，pi 升级后的壳解析自动跟上。
- 沙箱命令行长度固定，长命令、多引号的命令不再因为 `command line too long` 起不来。
- 完全权限下停止会连 msys 的后台子进程一起结束。

代价和已知缺口：

- 没配 `shellPath`、Git 也不在 Program Files 下时，pi 的查找会落到 PATH 上第一个 `bash.exe`；常见的是 WSL 启动器：完全权限下命令进 WSL，沙箱里直接拒绝。要用户在 settings.json 里设 `shellPath`。
- msys 的路径转换会改写传给原生程序的参数（如 `/c`），个别命令行为和 PowerShell 下不同；这是 Git Bash 的标准行为，不额外处理。
- 原生工具（`ping`、`ipconfig`）仍可能输出 GBK，按块解码可能误判，和以前一样。
- 停止后的补刀靠宿主进程还活着：agent-host 在停止后 3 秒内退出时，晚到的 bash 不会被补刀，pid 文件留在系统临时目录（几个字节）；agent-host 退出时 `pi-job-guard` 仍会清掉它的无窗口子孙。测试进程（vitest worker）退出得快，所以真实壳的停止用例要等进程真的没了再结束。
- 每条完全权限的 Windows 命令多写一个 pid 文件，停止时多起一个 bash。
- `permission denied` 也会出现在和沙箱无关的失败里（如 `git push` 的 `Permission denied (publickey)`），受限运行下这类失败会被归因成沙箱拒绝、给出升权提示；沙箱里读不到 `~/.ssh` 时这个归因恰好是对的。
- 冻结的 2026-09-15 PowerShell 设计（docs/superpowers、docs/decisions）原文不改，以本篇为准。

## Verification

结果：通过（下面「没覆盖」的项除外）。

- 单测：`cd extensions && npx vitest run _shared/sandbox sandbox` 在全量并行下连跑 3 轮都是 339 通过、26 跳过，跑完没有遗留的 Git Bash / sleep 进程（`.agents/evidence/2026-10-14-windows-bash-git-bash-like-pi/vitest-sandbox-under-load.txt`）。新增和改写的用例：未受限 Windows 是 `[Git Bash, -c, …]` 且环境原样；受限 Windows 交给 confine 的是固定引导、命令和 cwd 在环境变量里、`HOME` 去掉；8000 字符的命令命令行仍不到 500 字符；`Permission denied` 归为沙箱拒绝；WSL 在沙箱里拒绝、完全权限下走 stdin；`shellPath` 变了重新解析；找不到 bash 报 pi 的安装说明；停止时先整组 kill 再 taskkill；停止后才写出的 pid 也会被整组 kill；工具描述在 win32 上和 pi 一样、没有 PowerShell 规则。
- 全量：`cd extensions && npx vitest run`，2123 通过；唯一失败是 `shellPath.test` 首个用例在全量并行下动态加载 pi SDK 超过 5 秒，给该 describe 加 30 秒超时后单跑 4/4 通过（`vitest-extensions-full.txt`）。
- Git Bash 实跑（不经沙箱）：`operations.test.ts` 的 `Git Bash bootstrap live` 用 settings.json 的 `shellPath`（本机 `D:\Kits\Git\bin\bash.exe`）跑引导脚本：进 cwd、变量不泄漏、中文、引号、`exit 5` 透传；cwd 不存在时 163 且不执行；完全权限下 `sleep 317 & sleep 317; wait` 停止后两个 sleep 都没了。
- 沙箱实跑：`PI_SANDBOX_LIVE=1 PI_SANDBOX_LIVE_GIT='D:\Kits\Git\cmd\git.exe' npx vitest run _shared/sandbox/isolation.live.test.ts --testTimeout=180000`，20 通过、5 跳过（需提权的几项）（`isolation-live.txt`）。新加的 `live Git Bash through the sandboxed bash operations`：3000 多字符的命令在工作区里跑、中文、`HOME` 不是登录用户、`git --version`、`exit 7` 透传；写工作区外被拒、归因成沙箱拒绝、文件没建出来；停止后 bash 和后台 sleep 都结束。原有的 git init / commit / log 与工作区配置保护用例改成 bash 写法后照常通过。
- 进程组 kill 实验与长寿进程里的提前停止（0 / 30 / 80 / 150 / 300 / 600ms）都不留 sleep：`msys-group-kill.txt`；改造前在当前沙箱里跑 Git Bash 的探针结果：`gitbash-under-sandbox-probe.txt`。
- 没覆盖：没有在打包后的应用里经界面发消息跑 bash；没有在 Git 装在 Program Files 下、或只有 WSL 的机器上验证 pi 的默认查找；没有验证 Cygwin / MSYS2 自装的 bash；外部 U 盘、网络盘上的工作区。
