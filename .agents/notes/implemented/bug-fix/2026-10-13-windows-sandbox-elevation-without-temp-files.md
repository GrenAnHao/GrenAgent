# Agent Note: Windows 沙箱提权不落盘：脚本内联、结果走退出码

Status: implemented

## Problem

Windows 沙箱有三处要管理员权限：创建 PiSandbox 账户（`account.ts`）、给 `C:\Windows\Temp` 授列目录权（`account.ts`）、给系统公共目录加写拒绝（`ambient.ts`）。三处原来都是同一个写法：

1. 把脚本写成 `%TEMP%\pi-sandbox-*.ps1`，账户创建还把明文密码写进 `%TEMP%\pi-sandbox-plain-*.txt`；
2. `Start-Process -FilePath powershell.exe -Verb RunAs -File <脚本>` 提权执行；
3. 提权脚本往 `%TEMP%` 写一份 `icacls` 日志，非提权进程读日志判断成败。之所以绕这一圈，是因为当时读到的提权进程退出码总是 null。

问题：

- **借 UAC 提权。** 默认配置（`ConsentPromptBehaviorAdmin=5`）下，UAC 弹窗等用户点的那几秒里，脚本文件就在用户可写的 `%TEMP%` 里，同用户的任何进程都能把它换掉，换上的代码以管理员身份运行。用户在弹窗里只看得到“Windows PowerShell”，看不到脚本内容。
- **提权进程往用户可写目录写文件。** 日志路径在 `%TEMP%`，同用户进程可以把它所在的目录换成 junction，把提权写入引到别处。
- **按名字找 `powershell.exe`。** 经 PATH 查找，PATH 里排在 System32 前面的用户可写目录可以放一个同名程序。
- **提权进程从用户可写目录加载模块。** Windows PowerShell 5.1 的 `PSModulePath` 第一项是用户的 `Documents\WindowsPowerShell\Modules`（本机是 `D:\System Dir\Documents\WindowsPowerShell\Modules`）。账户脚本 `Import-Module Microsoft.PowerShell.LocalAccounts` 按名字查找，放在那里的同名模块会以管理员身份加载。
- **明文密码落盘。** 删除不是安全擦除。

本机 `ConsentPromptBehaviorAdmin=0`（管理员提权不提示），任何以用户身份运行的程序本来就能静默拿到管理员，所以上面这些在本机没有额外威胁；在默认配置的机器上才是实际问题。

## Decision

### 提权脚本内联，结果编码进退出码

新文件 `windows/elevate.ts`，三处提权都走 `runElevated(script)`：

- 脚本经 `-EncodedCommand`（UTF-16LE base64）内联传进提权进程，不写任何文件。
- 每个提权脚本前面自动加一行 `$env:PSModulePath = "$PSHOME\Modules"`（`ELEVATED_PRELUDE`）。这一行只是赋值，不调用命令，本身不会触发模块自动加载；之后的自动加载只在系统模块目录里找。
- 非提权的外层脚本 `Start-Process -Verb RunAs -PassThru` 之后先取一次 `$p.Handle`，再 `WaitForExit()`，退出码就读得回来；以前读到 null 是少了这一步。外层把退出码打到 stdout。只有 UAC 被拒（内层异常链上有 `Win32Exception`、`NativeErrorCode` 为 1223）才打 `PI-ELEVATE-CANCELLED`；其他启动失败把异常信息写到 stderr、以 1 退出。
- 提权脚本只在走到最后时以 `ELEVATED_DONE`（高位魔数 `0x2A5A0000`）加低 16 位结果退出。解析时负数、魔数以外的高位一律当作没完成（`null`）：NTSTATUS（`0xC…`）、CLR 未处理异常（`0xE0434352`）、被调试器结束（`0x40010004`）、`-1`、脚本出错的 `1` 都会带上别的高位或没有魔数。
- 外层失败时的错误信息不带命令行（Node `execFile` 的 `error.message` 会带完整命令行），stderr 只取第一行、最多 200 个字符；超时报“did not finish in time”。
- `powershell.exe` 一律用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 的绝对路径。外层进程去掉 `PSModulePath`（`windowsPowerShellEnv` 从 `account.ts` 移到这里，`account.ts` 照旧导出它）。
- `psQuote` 双写 ASCII 单引号和 U+2018–U+201B：PowerShell 把这四个排版引号也当单引号，只双写 ASCII 的话 `’` 可以闭合字符串、接着执行任意命令。`account.ts` 里原来的那份 `psQuote` 删除，统一用这一份。这也修了名字里带 `’` 的普通文件夹会把脚本弄坏的问题。

### 三处提权各自怎么报结果

- **账户创建**（`provisionScript` / `createProvision`）：
  1. 非提权进程先用 DPAPI（CurrentUser）加密密码，明文经子进程环境变量传入，返回 base64 密文；
  2. 删掉旧的 `account.bin`；
  3. 提权脚本只拿到密文，在内存里 `Unprotect`（CurrentUser 的密钥提权与否是同一把），然后建组、建用户或重设密码、调组成员；`LocalAccounts` 用 `$PSHOME\Modules\...` 的绝对路径导入；顺手给 Windows\Temp 授列目录权，这一行失败不影响整体（它另有确认，见下）；走到最后退出 `ELEVATED_DONE | 1`；
  4. 确认后由非提权进程写新 blob：先写同目录的 `*.partial`，再改名。

  密码因此不出现在任何命令行、脚本块日志（4104）、进程创建审计（4688）、错误信息里，也不以明文落盘。先删旧 blob 是为了不卡死：提权脚本改了密码而这边没收到结果（UAC 超时后才被点“是”、崩溃）时，缺 blob 会让下次重新创建，留着旧 blob 则每次登录都失败。原来先非提权跑一遍、失败再提权的做法去掉了：Pi 本身已提权时 `-Verb RunAs` 也不会弹窗。
- **Windows\Temp 列目录权**（`listGrantScript`）：提权脚本 `icacls /grant:r`，再经 .NET（`Directory.GetAccessControl`，按 `SecurityIdentifier`）读回 ACL，看到 PiSandbox 有 `FILE_LIST_DIRECTORY` 的 Allow 才退出 `ELEVATED_DONE | 1`。不再解析本地化的 `icacls` 输出，原来的 `windowsTempAllowsList` 删除。
- **系统目录写拒绝**（`ambientStampScript` / `createStampAmbient`）：逐个目录先读 ACL，已有一条 PiSandbox 的显式 DENY、权限包含整套 `0x10156`（WD、AD、WEA、WA、DC、D）、继承标志为 (OI)(CI)、没有 propagation 限制，才算已盖过并跳过；否则 `icacls /deny`，再用同样的条件读回确认，确认过的目录在结果里置对应的位。原来的 `parseAmbientLog`、`ambientDenyPresent` 删除。“先查再盖”是实测发现的：`icacls /deny` 对同一账户重复执行不会合并，会再加一条一模一样的 ACE。

## Alternatives considered

- **仍落盘，但放进一个只有当前用户能写的私有目录** — 最强理由：改动最小，脚本照旧是文件，好调试。没选是因为攻击者就是同一个用户：他是这个目录的所有者，所有者总能改 DACL，私有目录挡不住他。
- **照 srt 的做法，在 C 写的 helper 里加 `--provision` 等子命令，进程内调 `NetUserAdd`、`CryptProtectData`、`SetSecurityInfo`，提权 helper 本身** — 最强理由：完全不经 PowerShell，没有脚本、没有模块加载可劫持。没选是因为 C 端改动大得多；而且提权一个 exe 的前提是这个 exe 不能被沙箱改写，开发态下 helper 可能就在工作区里（另一个待修问题），先修那个再考虑。
- **把明文密码内联进提权脚本（本篇的第一版）** — 最强理由：最简单，密码只在提权进程运行那一两秒出现在它的命令行上。审查后放弃：开了进程创建审计（4688）、Sysmon 或 EDR 时命令行会被永久记录；开了脚本块日志（4104）时解码后的脚本也会进日志；外层超时时 Node 的错误信息带着整条命令行，会一路进到工具结果和会话文件。
- **用 stdin 或命名管道把密码交给提权进程** — 最强理由：密码不出现在提权进程的命令行上。没选是因为 `-Verb RunAs` 走 ShellExecute，不能重定向标准输入输出；命名管道要再写一套握手。DPAPI 密文已经达到同样的效果。
- **在提权脚本里生成密码并直接写 blob** — 最强理由：密码完全不离开提权进程。没选是因为提权进程要往 `~/.pi/sandbox` 写文件，又回到了“提权进程写用户可写路径”的问题。
- **退出码用第 30 位做“已完成”标记（本篇的第一版）** — 最强理由：位运算最简单，低 30 位都能当结果。审查后放弃：NTSTATUS 错误码和 CLR 崩溃码的第 30 位本来就是 1，`Ctrl+C` 退出会被读成“目录 1、3、4、5、8 已盖章”，`-1` 会被读成全部确认。
- **从注册表或 `GetSystemWindowsDirectoryW` 取 Windows 目录，不信 `SystemRoot` 环境变量** — 最强理由：同用户可以改 Pi 的环境变量，把绝对路径指到别处。没做是因为能改 Pi 环境变量的攻击者也能设 `NODE_OPTIONS`，直接在 Pi 里执行代码，修了也挡不住他；记为残余风险。

## Consequences

收益：
- 三处提权都不往磁盘写脚本、日志或明文密码，UAC 弹窗期间没有可以替换的文件。
- 提权进程不再加载用户目录里的模块。
- 密码只以 DPAPI 密文出现在命令行和日志里。
- 提权成败按退出码判断，崩溃、被杀、取消都不会被当成成功；按 SID 读 ACL，不受系统语言影响。
- 重复盖章不再产生重复的 ACE。

代价和残余风险：
- 外层非提权的 PowerShell 是同用户进程，同用户可以注入它、改它的参数，也可以自己弹一个“Windows PowerShell”的 UAC。所以这里做的是抬高门槛：去掉了“等用户点 UAC 时换文件”这条最便宜的路，没有把同用户攻击者挡在外面（默认 UAC 配置本来就不把同用户当边界）。
- `powershell.exe` 的绝对路径仍来自 `SystemRoot` 环境变量，见上。
- abort 只能停掉外层；提权进程已经起来了就由它跑完。
- 外层 Windows PowerShell 5.1 偶尔会在几百毫秒内自己崩溃（`0xC0000005`），什么也没报告。所有提权脚本都可以安全跑两遍，所以 `runElevated` 对这种崩溃（NTSTATUS 退出码）重试一次，超时、普通失败、用户取消不重试，见 [配置目录保护](2026-10-13-windows-sandbox-workspace-config-protection.md)。
- 一次提权最多报告 16 个目录的结果（当前清单 13 个），超过就直接报错。
- 脚本长度受命令行长度限制；实测 12072 个字符的编码命令可以正常提权并读回退出码，当前最长的脚本远小于这个长度。
- 账户创建脚本仍按名字 `'Users'`、`'Administrators'` 找组，非英文系统上会静默失败，这是另一个问题，本篇没动。
- 实测时多加的那条重复 ACE 已经清掉（提权 `icacls /remove:d` 后重新加一条）。
- 实测账户创建两次，PiSandbox 的密码各被重置了一次，`account.bin` 随之更新，沙箱照常登录。

相关：[PiSandbox 账户](../architecture/2026-10-02-windows-sandbox-pisandbox-account.md)（Windows\Temp 列目录权的确认方式）、[ambient 写拒绝](../architecture/2026-10-13-windows-sandbox-ambient-write-deny.md)（盖章方式）。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 前提：提权进程的退出码能否读回 | 临时探针：`Start-Process -Verb RunAs -PassThru` 后取 `$p.Handle` 再等，载荷只返回退出码 | 读回结果；确认是提权运行；4072 和 12072 字符的编码命令都正常；脚本出错时退出码 1 |
| 审查指出的三个问题先复现 | 见 `review-fixes.txt` | 旧标记下 `0xC000013A` 被读成“完成、结果 314”；`’` 闭合字符串后执行了 `Write-Output INJECTED`；PS 5.1 的 `PSModulePath` 第一项是用户 Documents |
| `elevate.ts`：编码、绝对路径、外层脚本、取消只认 1223、魔数与崩溃码、错误信息不带命令行、ACL 片段、Unicode 引号 | `cd extensions && npx vitest run _shared/sandbox/windows/elevate.test.ts` | 通过；新增用例先红后绿 |
| ambient：脚本无文件、整套掩码加 (OI)(CI) 才算已有、先查再盖、结果位映射、上限 16 | `npx vitest run _shared/sandbox/windows/ambient.test.ts` | 通过；先红后绿 |
| 账户创建与列目录权：提权脚本只见密文、绝对路径导入模块、顺序为加密→删旧 blob→提权→写新 blob、未确认不写 blob | `npx vitest run _shared/sandbox/windows/account.test.ts` | 通过；先红后绿 |
| 类型检查 | 临时 tsconfig（strict、`noUnusedLocals`）对 `elevate.ts`、`ambient.ts`、`account.ts` 跑 `tsc` | 通过 |
| 沙箱整体单测 | `npx vitest run _shared/sandbox` | 通过，182 项（14 项跳过） |
| 真机：提权进程钉住模块路径 | 一次性探针：在用户 Documents 的模块目录放一个空模块 `PiHijackProbe`，测完删除 | 普通 PowerShell 能看到它（对照）；`runElevated` 里 `PSModulePath` 等于 `$PSHOME\Modules`、看不到它 |
| 真机提权：结果位、出错为 null、ambient 盖章、Windows\Temp 列目录权，前后临时目录无新增文件 | `PI_SANDBOX_LIVE=1 PI_SANDBOX_LIVE_ELEVATE=1 npx vitest run _shared/sandbox/isolation.live.test.ts --testTimeout=180000` | 通过：整个文件 12 项通过、2 项跳过（强制分配失败需临时构建；账户重置单独跑） |
| 真机账户创建（审查修复后的流程） | 同上再加 `PI_SANDBOX_LIVE_PROVISION=1`，只跑提权那组 | 通过：`account.bin` 哈希变化，沙箱用新 blob 登录，`%TEMP%` 和 blob 目录都无残留 |
| 重复 ACE | `icacls C:\Users\Public` | 修复前出现两条相同的 DENY；清理并修复后多次重跑，只剩一条 |

证据：`.agents/evidence/2026-10-13-windows-sandbox-elevation-without-temp-files/`（`unit.txt`、`live.txt`、`live-provision.txt`、`acl.txt`、`review-fixes.txt`）。

没有覆盖：
- 用户在 UAC 弹窗里点“否”的路径：本机提权不弹窗，没法实测；取消的判断只有单测，按的是 `Win32Exception` 的 1223，真实异常链的形状没有在本机见过。
- 默认 UAC 配置下的弹窗流程。

结果：通过（上面“没有覆盖”的项除外）。
