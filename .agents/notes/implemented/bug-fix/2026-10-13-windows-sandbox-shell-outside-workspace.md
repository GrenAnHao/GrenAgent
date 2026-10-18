# Agent Note: Windows 沙箱里 PowerShell 静默从 C:\ 开始，命令不在工作区里跑

Status: implemented

## Problem

审批档「工作区」下，主代理的 bash 命令全部跑在 `C:\`，而不是会话工作区 `D:\System Dir\Downloads\note-pocock-flow\note-pocock-flow`。第一条 `pwd` 返回 `C:\`，模型据此认定自己不在工作区，再从系统提示 `<docs>` 段里的 pi 文档路径（开发目录的 `node_modules`）推断出 `D:\OneDrive\Project Files\Pi\electron-agent`，之后一直在开发目录里检索。系统提示的 `<cwd>` 和传给 bash 的 `ctx.cwd` 都是对的。

根因在 Windows 沙箱账户 `PiSandbox` 上。helper 把进程当前目录设成工作区，这一步靠「跳过遍历检查」能成功。但 PowerShell（pwsh 7 和 5.1 都一样）把进程当前目录规范成自己的位置时，`FileSystemProvider.NormalizeThePath` 要逐级读祖先目录的属性。`D:\System Dir\Downloads` 断开了继承，只给 Administrators / SYSTEM / 登录用户，`PiSandbox` 读不了它下面那一级的属性。PowerShell 不报错，静默把位置退回 `C:\`，相对路径和原生命令都跑在那里。

同样的形状很常见：用户目录下两层以上的工作区（`C:\Users\<me>\code\proj`、`C:\Users\<me>\.agents\skills\x`），父目录不可列出，子目录继承私有 ACL。

[Windows 沙箱 PiSandbox 账户](../architecture/2026-10-02-windows-sandbox-pisandbox-account.md)原定给工作区的每个祖先授 `(RA,X)`。代码后来用 `isGrantableAncestor` 收窄到 `.pi` 和临时目录父级，理由是「Set-Acl 在那些目录上会卡住」。实测卡住的原因是：`Set-Acl` 和 `icacls` 都走 `SetNamedSecurityInfo`，即使写的是不继承的 ACE，也会重写整棵子树（3 万个文件 30–47 秒）。收窄之后，工作区祖先一个都不授。

## Decision

### 只给读不到的工作区祖先授遍历，且只写这一个目录

`grantSandboxAccess` 在原有授权之后，对 `grants.json` 里还没有记录的工作区祖先先做一次探测：经同一个 helper，以 `PiSandbox` 身份跑 Windows PowerShell，对每个祖先调 `[IO.File]::GetAttributes`。路径经环境变量 `PI_SANDBOX_STAT_PATHS` 带进去，命令行长度固定，输出只有读不到的序号。读得到的记成 `reachable`，不改 ACL。读不到的授 `(RA,X)`（`SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_TRAVERSE`，不继承），记成 `RAX`。

`RAX` 的写法从 `Set-Acl` 换成 `SetFileSecurityW`（PowerShell `Add-Type` P/Invoke）：只写这一个安全描述符，不碰子树。原 DACL 带自动继承标志 `AI` 时，同时置 `SE_DACL_AUTO_INHERIT_REQ`，否则 `SetFileSecurityW` 会把 `AI` 丢掉。落盘结果就是原 DACL 加一条 ACE。`.pi` 祖先和临时目录父级的 `RAX` 也走这条路。

探测或授权失败不写记录，5 分钟内同一进程不再重试，免得每条命令都付一次 PowerShell 启动。这段时间里由下面的守卫兜底。

启动 `powershell.exe` 的子进程都去掉 `PSModulePath`：从 pwsh 7 起来的进程会把 7 的模块路径传下去，5.1 的 `Get-Acl` 报 `CouldNotAutoloadMatchingModule`。读 ACL 也不再用 `Get-Acl` cmdlet，直接构造 `DirectorySecurity`。

### 进不了工作目录就不跑命令

受限运行在用户命令前执行一段守卫。2026-10-14 起 bash 工具在 Windows 上照 pi 用 Git Bash（见 [Git Bash](../architecture/2026-10-14-windows-bash-git-bash-like-pi.md)），守卫是固定的 bash 引导脚本：`cd` 进期望的工作目录；进不去，就往 stderr 写 `pi-sandbox-win: the sandbox account cannot open the working directory <dir>; the command did not run`，以 163 退出。这条输出命中 Windows runner 的失败规则（退出码 163 + `pi-sandbox-win:`），bash 工具按「沙箱 runner 失败、命令没执行」报给模型，而不是让命令在 `C:\` 跑出一个看似正常的结果。

期望的工作目录和命令正文经环境变量 `PI_SANDBOX_CWD`、`PI_BASH_COMMAND` 带进去（helper 照抄调用方环境），命令行上只有那段固定的引导，长度和命令无关。引导进来先删掉这两个变量，用户命令和它的子进程看不到。不受限的运行不加守卫。原先 PowerShell 时代的守卫（`PI_SANDBOX_CWD_GUARD` + `iex`）已经删掉。

涉及文件：

- `extensions/_shared/sandbox/windows/account.ts`
- `extensions/_shared/sandbox/provider.ts`
- `extensions/_shared/sandbox/operations.ts`

## Alternatives considered

- **恢复原决定，给每个工作区祖先都授 `(RA,X)`，不探测** —— 最简单，和原笔记字面一致，不用以沙箱身份多起一次进程。不用：`C:\Users`、`D:\OneDrive` 这类本来就能读的目录会被改 ACL；当前用户对其中一些没有 `WRITE_DAC`，授权每次都失败。失败又不能写缓存，每条命令都要重试一遍。
- **在宿主进程里按 ACL 推算沙箱账户能不能读** —— 不用多起进程。不用：要自己算组成员（Users、Authenticated Users、INTERACTIVE、PiSandboxUsers）、拒绝 ACE、「父目录可列出则子项属性可读」这条隐式规则，算错了就是同样的静默错误。探测用的就是命令运行时那个令牌。
- **在宿主里 `LogonUser` 拿沙箱令牌再模拟身份去探测** —— 免掉一次 helper 启动。不用：要在 PowerShell 里解 DPAPI 密码、处理凭据，helper 已经安全地做了这件事。
- **把祖先改成可列出（`RD`）** —— PowerShell 也能规范路径。不用：会把用户 Downloads、用户目录下的文件名暴露给沙箱账户；原笔记已经否掉过。
- **用目录联接或 `subst` 盘符让 PowerShell 从可读路径起步** —— 不改用户目录 ACL。不用：`pwd` 和输出里的绝对路径会和 `<cwd>` 不一致，模型照样会迷路。
- **守卫直接写进 `PS_UTF8_PREFIX`** —— 不需要环境变量。不用：受限运行的命令行受 `CreateProcessWithLogonW` 约 1024 字符限制，前缀和启动器已经吃掉大半。守卫约 300 字符，会把更多命令挤到 `-File` 脚本路径，而 `-File` 不传播最后一条原生命令的失败（实测 `-Command` 退出 1、`-File` 退出 0）。
- **只修授权、不加守卫** —— 改动更小。不用：授权失败、缓存过期、`working_directory` 切到工作区外的目录时，命令还会静默跑在 `C:\`。这正是这次的症状。

## Consequences

- **收益**：工作区祖先私有时，命令在工作区里跑。沙箱账户进不去时，模型看到明确的沙箱失败，而不是 `C:\` 的内容。授权只落在真正读不到的目录上，每个目录一条不继承的 ACE，几十毫秒，不遍历子树。
- **代价**：新工作区第一条受限命令多一次以 `PiSandbox` 身份启动的探测，以及每个读不到的祖先一次 `powershell.exe` + `Add-Type`（实测整条命令首次约 7 秒，之后走缓存）。`grants.json` 多了 `reachable` 这种值。
- **已知上限**：`reachable` / `RAX` 记录不会过期。用户之后改了祖先目录的 ACL，缓存就失准，这时由守卫报错兜底。要重新探测，删掉 `grants.json` 里对应的键即可。当前用户对某个私有祖先没有 `WRITE_DAC` 时授不上，命令持续报沙箱失败，只能切到「完全权限」。
- **另一个问题（未在本次修）**：PATH 里用户目录下的大目录（例如 zig 工具链），`RX` 授权走 `icacls /T`，每次都在 5 秒超时、不写缓存，于是每条受限命令都多等 5 秒。

## Verification

- 单测：`cd extensions && npx vitest run _shared/sandbox/ sandbox/`，231 通过、2 跳过。新增用例覆盖：只给读不到的祖先授 `RAX`、全部记录后不再探测、授权失败按冷却不重试、探测失败不写记录、没有探测时不碰祖先、`PSModulePath` 清理、守卫环境变量只给受限 PowerShell、163 + `pi-sandbox-win:` 归为 runner 失败。另有 Windows 实跑用例：位置漂走时守卫把它切回进程当前目录、变量不泄漏、约束语言模式下不报错。输出见 `.agents/evidence/2026-10-13-windows-sandbox-shell-outside-workspace/vitest-sandbox.txt`。
- 实跑：真实 `createSandboxedBashOperations` → `createSandboxProvider` → `pi-sandbox-win.exe` → `PiSandbox`，工作区放在用户目录下两层（祖先私有），`grants.json` 用临时文件。不探测时守卫拦下命令（退出 163、runner 失败）；开启探测后首条命令给两个私有祖先授 `RAX`，`C:\Users\rxstudio`、`C:\Users` 记为 `reachable`，命令在工作区里执行并读到 `.\hello.txt`；后续命令走缓存。结果：通过。见 `.agents/evidence/2026-10-13-windows-sandbox-shell-outside-workspace/e2e-live.txt`。
- 诊断过程与 ACL 写入耗时对比：`.agents/evidence/2026-10-13-windows-sandbox-shell-outside-workspace/diagnosis.txt`。
