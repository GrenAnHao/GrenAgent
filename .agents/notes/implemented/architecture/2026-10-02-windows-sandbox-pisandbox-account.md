# Agent Note: Windows 沙箱用 PiSandbox 专用账户与无控制台启动器

Status: implemented

## Problem

### Windows 沙箱用无控制台启动器换账户

专用账户 `PiSandbox` 仍然是 Windows 沙箱的启动身份。`CreateProcessWithTokenW` 在这个进程里返回 1314（`ERROR_PRIVILEGE_NOT_HELD`）：交互用户没有 `SeImpersonatePrivilege`，命令不会启动。`CreateProcessWithLogonW` 不需要这项特权，但它拒绝 `CREATE_NO_WINDOW`，直接启动 PowerShell 会弹出控制台。

### 长命令写入临时脚本文件，绕开 CreateProcessWithLogonW 的字符上限

`CreateProcessWithLogonW` 的 `lpCommandLine` 参数通过 Secondary Logon Service（seclogon）的 RPC 通道传输，受约 1024 宽字符的内部缓冲限制。`pi-sandbox-launch.exe` 路径、shell 标志和 `PS_UTF8_PREFIX` 消耗约 450 字符，留给用户命令的空间只剩约 580 字符。多行脚本、内联 `node -e`、中文提示词很容易超过这个上限。超过后 `CreateProcessWithLogonW` 返回 `E_INVALIDARG`（0x80070057），此前被误判为间歇性故障。

### Windows 沙箱环境变量改用 PiSandbox 自己的主目录

账户启动会把调用方的环境整份复制给沙箱进程，只改 `TEMP`/`TMP`/`TMPDIR`。复制结果仍是登录用户：`USERNAME` 为 rxstudio，`USERPROFILE` 为 `C:\Users\rxstudio`，`TEMP` 落在该用户 `AppData\Local\Temp\pi-sandbox\<uuid>`。令牌身份是 PiSandbox，这个主目录和临时目录都不可写。`os.homedir()` 跟着 `USERPROFILE` 走，所以家目录和临时目录一起失败。

### Windows 沙箱补祖先遍历、工作目录和进程树回收

专用账户能跑子进程之后，实测还有几处对不齐。工作区在 `C:\Users\<user>\.pi\agent\works\<id>` 下，祖先目录拒绝 `lstat`，node 的 `realpath` 因此无法执行工作区内的脚本。`TEMP` 指到用户 Temp 下的 `pi-sandbox\<id>`，父目录同样不可遍历，写入得到 EPERM 而不是 ENOENT。`CreateProcessWithLogonW` 的 `lpCurrentDirectory` 传了 NULL，新登录的默认目录是 `C:\Windows\System32`。命令结束后 detached 子进程还在。

### Windows Temp 的列出权必须看到 ACL 才算授上

`C:\Windows\Temp` 对 Users 是可建文件、不可列出。PowerShell 7 的 `Remove-Item` 在 `RemoveItemCommand.ProcessRecord` 里调用 `IsReparsePointLikeSymlink`，后者对完整路径做 `FindFirstFile`。父目录没有 `FILE_LIST_DIRECTORY` 时，这个调用返回 Win32 错误 5，文件还在。`cmd del` 同样走 `FindFirstFile`，于是报找不到。node `unlink` 和 `File.Delete` 走 `DeleteFileW`，创建者对文件有完全控制，所以能删。`readdir` 走 `NtQueryDirectoryFile`，同样因没有列出权而 EPERM。上一轮把 `grants.json` 记成了 `RD`，但提权后的 `Start-Process -Verb RunAs` 拿不到子进程退出码，`exit $null` 被当成 0，ACE 实际没写上。

### 不缓存 C:\Windows\Temp 的列出权 ACL 授予

`grantSandboxAccess` 把所有 ACL 授予记录在 `~/.pi/sandbox/grants.json` 中。`C:\Windows\Temp` 的 `(S,RD)` 授予也被缓存后，如果系统通过 Windows Update、组策略或修复操作重置了该目录的 ACL，下次启动沙箱时缓存显示"已授予"而跳过实际 `icacls`，导致 `Remove-Item` 和 `readdirSync` 继续失败（缺陷 5 和 7 的复现）。

## Decision

### Windows 沙箱用无控制台启动器换账户

helper 用 `CreateProcessWithLogonW` 启动旁边的 `pi-sandbox-launch.exe`。这个 exe 是 Windows 子系统，自己没有控制台。它再以 `CREATE_NO_WINDOW` 启动真正的命令，并继承标准输入输出。账户、DPAPI 密码和目录授权不变。

### 长命令写入临时脚本文件，绕开 CreateProcessWithLogonW 的字符上限

当用户命令超过 400 字符时，`operations.ts` 将 `PS_UTF8_PREFIX` + 命令体写入沙箱临时目录下的 `.ps1` 文件（带 UTF-8 BOM），shell argv 改用 `-File <path>` 替代 `-Command <inline>`。`lpCommandLine` 因此固定在约 250 字符以内，与命令长度无关。`helper.c` 增加预检：`wrapped` 超过 1000 字符时直接报明确的长度错误并退出，不再盲目重试。

### Windows 沙箱环境变量改用 PiSandbox 自己的主目录

`--sandbox-home` 传入 `C:\Users\PiSandbox`。helper 在复制环境时改写 `USERNAME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`TMPDIR`，`TEMP` 为该主目录下的 `AppData\Local\Temp`。`PATH` 仍来自调用方，这样能找到 node。启动器在跑命令前把这些目录建出来。

### Windows 沙箱补祖先遍历、工作目录和进程树回收

祖先目录只授 `FILE_READ_ATTRIBUTES | FILE_TRAVERSE`（`(RA,X)`，不继承），用 `SetFileSecurityW` 只写这一个目录。`.pi` 祖先和临时目录父级直接授；工作区祖先先以 `PiSandbox` 身份探测，只授读不到属性的那几级。受限 PowerShell 进不了工作目录时以 163 退出，不在别处跑（见 [PowerShell 静默从 C:\ 开始](../bug-fix/2026-10-13-windows-sandbox-shell-outside-workspace.md)）。不授列出和读取内容的权限。临时目录本身仍授 Modify，并且 helper 把当前目录（operations 设成会话工作区）传给 `CreateProcessWithLogonW`。启动器进程放进带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、不允许 breakaway 的 Job；helper 在读完退出码后关闭 Job，回收还活着的后代。`CreateProcessWithLogonW` 遇到 `ERROR_INVALID_PARAMETER` 时最多再试两次。

### Windows Temp 的列出权必须看到 ACL 才算授上

仍只加 `(S,RD,RA)`，不追加写权限，也不继承。提权脚本把 `icacls` 的目录 ACL 写到日志里，日志里能看到 `PiSandbox` 的列出权才把缓存写成 `RD1`。旧的 `RD` 记录不算数。祖先目录的 `(RA,X)`、工作目录和 Job 回收不变。

### 不缓存 C:\Windows\Temp 的列出权 ACL 授予

对 `RD` 权限类型的 target 跳过缓存检查，每次都重新执行 `icacls`。`RD` 授予只用于 `C:\Windows\Temp` 一个目录，且需要 UAC 提权——`elevateIcacls` 已保证同一进程内最多弹出一次 UAC 对话框。

### 涉及文件

- `extensions/_shared/sandbox/windows/helper.c`
- `extensions/_shared/sandbox/windows/launch.c`
- `extensions/_shared/sandbox/operations.ts`
- `extensions/_shared/sandbox/windows/account.ts`
- `extensions/_shared/sandbox/windows/runner.ts`
- `extensions/_shared/sandbox/provider.ts`
- `extensions/_shared/sandbox/windows/deleteSemantics.test.ts`

### 来源

- `docs/decisions/extensions/2026-10-02-windows-sandbox-launch-exe.md`
- `docs/decisions/extensions/2026-10-02-windows-sandbox-cmd-length.md`
- `docs/decisions/extensions/2026-10-02-windows-sandbox-profile-env.md`
- `docs/decisions/extensions/2026-10-02-windows-sandbox-traverse-job.md`
- `docs/decisions/extensions/2026-10-02-windows-sandbox-temp-findfirst.md`
- `docs/decisions/extensions/2026-10-02-windows-sandbox-rd-cache.md`
- `docs/decisions/extensions/2026-10-02-windows-sandbox-account.md`（已被取代）
- `docs/decisions/extensions/2026-10-02-windows-sandbox-no-console.md`（已被取代）
- `docs/decisions/extensions/2026-10-02-windows-sandbox-temp-list.md`（已被取代）
- b0fe7954
- `docs/superpowers/specs/2026-09-12-os-sandbox-design.md`

## Alternatives considered

### 更早被放弃的路径：WSL / sandbox-runtime 隔离

b0fe7954（2026-07-01）「drop WSL/sandbox-runtime isolation path」：移除 sandbox-gate、sandbox_sh / sandbox_exec、safety 的 bash 拦截和 WSL 安装界面，当时改为仅宿主执行；之后 2026-09-12 按规格 `docs/superpowers/specs/2026-09-12-os-sandbox-design.md` 重做 OS 沙箱。放弃 WSL 路径的原因（用户说明）：过于复杂，而且不一定每个开发者都会开启 WSL。

### Windows 沙箱用无控制台启动器换账户

- 继续 `CreateProcessWithTokenW`：1314，命令起不来。
- `CreateProcessWithLogonW` 直接启动 PowerShell，只加 `SW_HIDE`：控制台子系统仍会先建窗口。
- 用 SYSTEM 服务做 `CreateProcessAsUserW`：能藏窗口，但要常驻服务和安装步骤。

### 长命令写入临时脚本文件，绕开 CreateProcessWithLogonW 的字符上限

- 把命令通过 stdin 管道传入 `pwsh -Command -`：当前 spawn 设置使用 `stdio: ["ignore"]`，改动影响面大，且与 `CreateProcessWithLogonW` 的句柄继承配合复杂。
- 在 C 侧（helper.c）写临时文件：helper 以调用者身份运行，PiSandbox 不一定有读取权；跨用户文件权限增加额外配置。
- 只把缓冲区调大：`CreateProcessWithLogonW` 的限制在 seclogon 服务内，调用者无法改变。

### Windows 沙箱环境变量改用 PiSandbox 自己的主目录

- 继续把 `TEMP` 放在登录用户的 `pi-sandbox\<uuid>` 下并补写权限：父目录不可创建子项，叶子从未出现，而且家目录仍然指错人。
- 保留登录用户的环境，只把 `Documents` 等子目录授权给 PiSandbox：那是在别人的配置目录上开口，工具仍会读到错误的 `.npmrc` / `.gitconfig`。

### Windows 沙箱补祖先遍历、工作目录和进程树回收

- 把祖先目录改成可列出、可读：`.pi` 和用户配置文件的内容会暴露给沙箱账户。清单里这些拒绝是设计如此。
- 把 `TEMP` 挪到 `C:\Windows\Temp`：那边对 Users 可写，但列目录和按枚举删除并不稳定，scratch 文件会和系统临时文件混在一起。
- 给 `C:\Windows\Temp` 补列出权限，让 `Remove-Item` 和 `cmd del` 与 `DeleteFile` 一致：那个目录的 ACL 本来就是「可创建、不可列出」。`FindFirstFile` 失败时 cmd 报 Could Not Find，PowerShell 报拒绝访问；`DeleteFile` / `File.Delete` 按完整路径仍能删。补列出权限会让沙箱读到别人的临时文件。

### Windows Temp 的列出权必须看到 ACL 才算授上

- 相信 `Start-Process -Verb RunAs -PassThru` 的 `ExitCode`：它经常是 null，null 被当成成功，授权被跳过。
- 每次命令都重新提权：用户会反复看到 UAC，而且上次就是这样把失败记成了成功。
- 改授修改权限：Users 本来就能建文件，多出来的写权限盖不住 `FindFirstFile` 失败。

### 不缓存 C:\Windows\Temp 的列出权 ACL 授予

- 在授予后用 `readdirSync` 验证再决定是否缓存：需要以 PiSandbox 身份运行验证脚本，增加复杂度。
- 完全不再使用 `C:\Windows\Temp`：`TEMP` 已改指 PiSandbox 的 profile，但第三方工具可能硬编码 `C:\Windows\Temp` 为后备路径，放弃授予会让那些工具在枚举和删除时失败。

### 已被取代的旧决定：Windows 沙箱改为专用本地账户启动

工作区沙箱在 Windows 上改为 `CreateProcessWithLogonW`，以专用本地账户 `PiSandbox` 启动命令。该账户的 SID 就是管道所有者，命名管道的写检查可以通过。工作区和会话临时目录用 icacls 授予该账户；用户配置文件下的 PATH 目录只授执行。账户第一次创建需要一次提权。密码用 DPAPI 存在当前用户的 `~/.pi/sandbox/account.bin`，不进命令行。

当时放弃的方案：

- 在受限进程里挂钩 `CreateNamedPipeW`：要给每个孙进程注入 DLL，比换账户更脆。
- 把当前用户 SID 加进 restricting SID：写检查会在用户能写的任何路径上通过，工作区边界没了。
- 照搬 Codex 的 Windows 服务：服务能做同样的 `CreateProcessAsUser`，但 Pi 的 helper 已经在用户进程里，`CreateProcessWithLogonW` 不需要常驻 SYSTEM 服务。
- 继续用当前用户的写限制令牌，测试靠升到完全权限：工作区档仍然跑不了测试。

### 已被取代的旧决定：Windows 沙箱账户启动时不弹出控制台

helper 先 `LogonUserW`，再 `CreateProcessWithTokenW`，创建标志带 `CREATE_NO_WINDOW`，启动信息里再把窗口设为隐藏。调用进程打开 `SeImpersonatePrivilege`。账户、DPAPI 密码和目录授权不变。

当时放弃的方案：

- 继续用 `CreateProcessWithLogonW`，只加 `SW_HIDE`：这个 API 拒绝 `CREATE_NO_WINDOW`，控制台子系统仍会先建窗口。
- 改回 `CreateProcessAsUserW` 加 `CREATE_NO_WINDOW`：当前用户进程没有 `SeAssignPrimaryTokenPrivilege`，这条路是 Codex 服务进程才走得通的。

### 已被取代的旧决定：给 PiSandbox 补上 Windows Temp 的列出权，让删除路径一致

给 PiSandbox 增加该目录本身的 `(S,RD)`，不继承、不追加写权限。`FindFirstFile` 因此能看见文件，`Remove-Item` 和 `cmd del` 与 `DeleteFileW` 一样能删掉它。当前用户改不了这个 ACL 时，同一次进程里只弹出一次 UAC 去执行 `icacls`。

当时放弃的方案：

- 再授一份写或修改权限：Users 本来就能建文件，多出来的写权限盖不住“列出失败”，也扩大了共享临时目录上的权限。
- 只授 `RD`、不带 `S`：单独的列出权不够，`dir` 仍然失败；同步权要和列出权在一起，`FindFirstFile` 才成功。
- 改 cmd / PowerShell：这两条路径在系统里，沙箱碰不到。

## Consequences

### Windows 沙箱用无控制台启动器换账户

`pi-sandbox-launch.exe` 必须和 `pi-sandbox-win.exe` 放在同一目录，打包时一起 unpack。缺了它，helper 以 163 退出，命令不会执行。

### 长命令写入临时脚本文件，绕开 CreateProcessWithLogonW 的字符上限

命令体无实际长度限制（仅受文件系统约束）。脚本文件由 24 小时 TTL 扫描清理。`-File` 模式与 `-Command` 模式在退出码语义上有细微差异（`$LASTEXITCODE` 传播规则），目前场景下无影响；如果将来出现差异，可改为 `-Command "& '<path>'"`。

### Windows 沙箱环境变量改用 PiSandbox 自己的主目录

沙箱里的家目录和临时目录属于 PiSandbox，不再是当前登录用户。第一次 `LOGON_WITH_PROFILE` 会创建该配置文件。调用方的 `PATH` 被保留，profile 专用变量不会。

### Windows 沙箱补祖先遍历、工作目录和进程树回收

祖先目录可以被 `lstat`，不能被 `readdir`。`node <工作区内脚本>` 不再因为 `.pi` 不可 stat 而失败。`TEMP` 仍在用户 Temp 下的 `pi-sandbox` 目录，但祖先可遍历且目录已创建。Job 收不进去时命令照样跑，stderr 留下 `AssignProcessToJobObject` 的错误码，detached 进程可能残留。`C:\Windows\Temp` 上四条删除路径仍然不一致，这是该目录的 ACL，不是 cmdlet 策略。

### Windows Temp 的列出权必须看到 ACL 才算授上

`PiSandbox` 可以列出 `C:\Windows\Temp` 里的文件名。这是让 `readdir`、`Remove-Item` 和 `cmd del` 与 `DeleteFileW` 一致的最小权利。确认失败时不写入缓存，五分钟内不重复弹出 UAC。

### 不缓存 C:\Windows\Temp 的列出权 ACL 授予

每个 agent 进程首次启动沙箱时会尝试一次 unelevated `icacls`（约 100ms），失败后尝试一次 UAC 提权。如果用户取消 UAC，授予静默跳过（已有 `continue` 兜底），不阻塞命令执行。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
