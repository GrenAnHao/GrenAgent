# Agent Note: Windows 沙箱 job 收紧：UI 限制、分配失败即终止、环境变量过滤

Status: implemented

## Problem

对照 Anthropic sandbox-runtime（srt）的 Windows 实现后，Pi 的 Windows 沙箱有三处启动侧缺口，都在 `extensions/_shared/sandbox/` 内，不需要新依赖：

1. **job 没有 UI 限制。** `windows/helper.c` 给 job 只设了 `KILL_ON_JOB_CLOSE`。`CreateProcessWithLogonW` 没传 `lpDesktop`，沙箱命令落在用户的 `WinSta0\Default`，与用户同为 Medium IL。命令可以读写剪贴板、读写全局 atom、改系统参数和显示设置、操作 job 外的 USER 句柄。旧 helper 下 `echo x| clip` 在沙箱里退出码为 0，实测写进了用户剪贴板。
2. **job 分配失败后继续跑。** `AssignProcessToJobObject` 失败只打一行警告，把 `job` 置空然后等待。命令是 seclogon 拉起的 PiSandbox 子进程，不在 helper 的进程树里，`operations.ts` 超时或中止时的 `taskkill /pid <helper> /t /f` 杀不到它。
3. **环境变量整份复制。** `helper.c` 的 `env_for_sandbox` 复制调用方环境，只改写身份相关变量。agent-host 子进程在 `electron-agent/electron/main.ts` 里以 `{ ...process.env }` 启动，所以用户系统环境里的 `GH_TOKEN`、`OPENAI_API_KEY` 之类会原样进入沙箱命令。供应商密钥存在 `auth.json`，不在环境里，不受影响。终端、shell、子代理三条路径已由 `sandboxManager.ts` 的 `filterEnvironment` 过滤同类变量，bash 工具这条路径漏掉了。

沙箱目前没有网络围栏，环境里的密钥一旦进入命令就能直接外发。

## Decision

### job 带 UI 限制

`helper.c` 创建 job 后调用 `SetInformationJobObject(JobObjectBasicUIRestrictions)`，标志位：`HANDLES`、`READCLIPBOARD`、`WRITECLIPBOARD`、`GLOBALATOMS`、`SYSTEMPARAMETERS`、`DISPLAYSETTINGS`、`DESKTOP`、`EXITWINDOWS`，与 srt `job.rs` 一致。设置失败时关 job 并 `fail()` 退出，不降级继续。

沙箱内 `clip.exe` 与 `Set-Clipboard` 因此失效，这是接受的代价。

这一项**不能**挡住低级键盘钩子（`WH_KEYBOARD_LL`），srt 自己的注释也这么说；要挡住需要独立随机桌面，另开一篇。

### job 分配失败即终止

`AssignProcessToJobObject` 失败时，helper 在 stderr 写 `pi-sandbox-win: AssignProcessToJobObject failed <code>`，对 launcher 调 `TerminateProcess(pi.hProcess, HELPER_FAIL_EXIT)`，随后走正常的等待与清理路径，退出码为 163。`TerminateProcess` 本身失败时 `fail()`。`runner.ts` 现有的 `runner-launch-failed` 分类沿用。

helper 只能在 `CreateProcessWithLogonW` 返回之后才把 launcher 放进 job，而且打不开 PiSandbox 账户的进程句柄，所以回收命令不靠它：见下一节，命令在 launcher 自己的 job 里。

`helper.c` 里有 `#ifdef PI_TEST_FAIL_ASSIGN`，编译时定义它会先睡 2 秒（让 launcher 来得及拉起命令）再强制走失败分支，只给 live 测试用，入仓的 exe 不带。

### 命令在 launcher 自己的 job 里

`launch.c` 创建一个 `KILL_ON_JOB_CLOSE`、不带 breakaway 的 job，以 `CREATE_SUSPENDED` 启动命令，`AssignProcessToJobObject` 成功后才 `ResumeThread`。分配或恢复失败时终止命令并以 163 退出。launcher 是普通 `CreateProcessW`，不受 `CreateProcessWithLogonW` 的挂起死锁限制。job 的最后一个句柄在 launcher 手里，launcher 被 helper 终止或随外层 job 被回收时，命令随之被杀，所以命令不会在 helper 的 job 之外存活。依赖 Windows 8 以上的嵌套 job。

### bash 工具的环境变量过滤

`extensions/_shared/sandbox/env.ts` 导出 `filterSecretEnv`。`operations.ts` 的 `exec` 在确认是受限运行（`isConfined`）之后，对环境做一次过滤得到 `confinedEnv`，之后的 `PS_CWD_GUARD_ENV` 写入和 `run(confined.argv, …)` 都用它。`danger-full-access` 等不受限路径沿用未过滤的环境。

规则：变量名匹配 `/(TOKEN|SECRET|PRIVATE_KEY|API_KEY|PASSWORD)/i` 的丢弃；`PI_HUMAN_ORIGIN_TOKEN` 与 `PI_SANDBOX_CWD_GUARD` 精确放行，比较时统一转大写（Windows 环境变量名不区分大小写）。**不按 `PI_` 前缀放行**，否则用户自己设的 `PI_OPENAI_API_KEY` 之类会绕过过滤。

`sandboxManager.ts` 的 `filterEnvironment` 保持不动：它不放行 `PI_` 变量，合并会改变终端、shell、子代理三条路径的行为，不在本篇范围。两份正则目前是重复的。

### 二进制与构建脚本

`pi-sandbox-win.exe` 与 `pi-sandbox-launch.exe` 都用 MSVC 重编后入仓（在 `vcvars64` 环境里跑 `scripts/build-sandbox-helper.mjs` 的 `cl` 分支）。脚本里 launcher 的 `/SUBSYSTEM:WINDOWS` 原来写在 `/link` 之前，被 `cl` 忽略并报 D9002；入口是 `WinMain`，链接器本来就推断成 Windows 子系统，所以没有实际后果。现在改成 `/link /SUBSYSTEM:WINDOWS`，并在编完后读 PE 头核对 launcher 的子系统是 Windows（2），不是就失败。

## Alternatives considered

- **在 helper 里做严格环境白名单（srt 的做法：`lpEnvironment=NULL` 叠加 PATH、PATHEXT 和代理变量）** — 最强理由：它是失败安全的，新增的敏感变量名不会漏过去。没选是因为用户给项目配的变量（`resolveEnv`、MCP、构建工具链变量）也会被一并丢掉，且 Pi 当前没有 srt 那样的代理层来补回需要的变量，误杀成本高于漏过的风险。
- **按 `PI_` 前缀放行内部变量** — 最强理由：以后新增内部变量不用改名单。没选是因为它让 `PI_*_API_KEY` 这类用户变量绕过过滤，审查时指出。
- **只靠 job UI 限制，不做独立桌面** — 这就是本篇的第一项；独立桌面（`CreateDesktop` + `lpDesktop` + 窗口站授权 + `BaseNamedObjects` 授权）能挡键盘钩子，但 srt 为此踩了 `DLL_INIT_FAILED` 与 msys2 起不来的坑，改动面大，放进同一篇会让本篇无法单独验证。
- **分配失败后继续运行并告警（原状）** — 最强理由：不因 job 的偶发失败打断用户命令。没选是因为失败后命令不受 `KILL_ON_JOB_CLOSE` 约束，超时后会留下孤儿进程；srt 也只容忍 `ERROR_NOT_SUPPORTED` 这一种。
- **用 Toolhelp 遍历在失败时递归杀 launcher 的子孙** — 最强理由：不用改 launcher。没选是因为 helper 以用户身份运行，打不开 PiSandbox 账户进程的句柄，行不通；改由 launcher 自己的 job 回收。
## Consequences

收益：
- 沙箱命令碰不到用户剪贴板、系统参数和显示设置，job 外的 USER 句柄也不可达。
- job 分配失败不再悄悄带病运行，而是退出 163 并有明确原因，已被拉起的命令随 launcher 一起被回收。
- 用户系统环境里的凭据类变量不再进入受限的 bash 命令。

代价和已知缺口：
- 沙箱内 `clip.exe`、`Set-Clipboard` 不可用。
- 命令靠 launcher 的 job 回收，依赖嵌套 job（Windows 8 以上）；`CREATE_SUSPENDED` 启动加 job 分配给每条命令多了几次系统调用。
- 环境过滤按名字匹配，会误伤名字里恰好带 `TOKEN` 的无害变量，也挡不住名字里不带这些词的敏感变量，是降低风险，不是边界。依赖 `GH_TOKEN` 的 `gh`、`git` 认证在沙箱内会失败，需要用户在项目环境里显式给。
- 低级键盘钩子不在这次覆盖范围内。
- `sandboxManager.ts` 与 `env.ts` 各有一份凭据正则，会漂移。

## 验证

编译器：MSVC（`D:\Program Files\Microsoft Visual Studio\18\Enterprise`，`vcvars64`），本机没有 gcc。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 环境过滤与 `exec` 接线 | `cd extensions && npx vitest run _shared/sandbox/env.test.ts _shared/sandbox/operations.test.ts` | 通过，44 项 |
| UI 限制（合法命令照常、剪贴板被挡） | `PI_SANDBOX_LIVE=1 npx vitest run _shared/sandbox/isolation.live.test.ts --testTimeout=180000`，用入仓的重编 helper | 通过，4 项（强制分配失败那项在此跳过） |
| 分配失败退出 163，且已拉起的命令被回收 | 同上，另设 `PI_SANDBOX_LIVE_FAIL_ASSIGN_HELPER` 指向用 `-DPI_TEST_FAIL_ASSIGN` 临时编出的 helper（放在 `D:\sbx-test-build`，测完删除，未入仓） | 通过，5 项 |
| 退出码透传 | 同上 live 用例里 `cmd /c exit 7` | 通过 |
| 沙箱整体单测 | `cd extensions && npx vitest run _shared/sandbox` | 通过，140 项（5 项跳过） |

对照基线一：改动前用旧 helper 跑剪贴板用例，`echo secret| clip` 在沙箱里退出码为 0，用例失败（红）；换新 helper 后被挡（绿）。基线输出没有存成文件，记在这里。

对照基线二：launcher 还没有自己的 job 时，同一个强制失败用例里 `ping -n 30` 逃出 job 跑满，耗时 29453ms，断言 `< 15000` 失败（红）；加上 launcher 的 job 后命令被回收（绿）。同样没有存成文件。

证据：`.agents/evidence/2026-10-13-windows-sandbox-job-hardening/`（`unit.txt`、`live-checked-in-helper.txt`、`live-fail-assign.txt`）。

没有覆盖：
- `node`、`git`、msys 在新 job 下是否照常运行没有测，只测了 `cmd /c`、`powershell -NoProfile -Command`。
- 独立随机桌面（挡键盘钩子）不在本篇范围。
- 本机之前 `deleteSemantics.test.ts` 与既有 live 用例在默认 5 秒超时下失败，原因是 icacls 授权慢，与本篇无关；放宽超时后通过，最后一次全量单测也通过。

结果：通过（上面“没有覆盖”的项除外）。

相关：[PiSandbox 账户与无控制台启动器](2026-10-02-windows-sandbox-pisandbox-account.md)（同一个 helper 与 job，本篇不改其 Decision）。
