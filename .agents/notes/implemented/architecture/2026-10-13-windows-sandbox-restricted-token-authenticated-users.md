# Agent Note: Windows 沙箱命令用 Authenticated Users 为 deny-only 的受限令牌

Status: implemented

## Problem

`workspace-write` 下沙箱命令能写工作区之外的目录：2026-10-13 在本机探测（工作区内写入作正对照），`D:\` 下工作区的兄弟目录和 `D:\OneDrive` 都能写。原因是数据盘根上的 ACL 是 `Authenticated Users:(OI)(CI)(IO)(M)`（`Users` 只有读），PiSandbox 登录后令牌里带着 `Authenticated Users`（S-1-5-11），一路继承下来。

沙箱令牌里的组（`whoami /groups` 在沙箱里实测）：`Everyone`、`PiSandboxUsers`、`BUILTIN\Users`、`INTERACTIVE`、`CONSOLE LOGON`、`Authenticated Users`、`This Organization`、本地账户、`LOCAL`、`NTLM Authentication`，完整性级别 Medium。特权只有标准用户那几项（`SeChangeNotifyPrivilege` 启用，另三项禁用）。令牌里**没有**登录会话 SID（`S-1-5-5-*`）。

## Decision

`windows/launch.c` 的 launcher 用自己进程令牌的受限副本启动命令：`CreateRestrictedToken(self, 0, 1, &{Authenticated Users, 0}, 0, NULL, 0, NULL, &restricted)`，再 `CreateProcessAsUserW(restricted, …)`。把 `Authenticated Users` 放进 `SidsToDisable` 之后它在令牌里变成 deny-only：允许这个组的 ACE 不再算，拒绝这个组的 ACE 仍然生效。

- 账户自己的 SID 不动，所以工作区、临时目录上显式授给 PiSandbox 的 `M` 照常有效。
- `Users`、`Everyone` 不动，系统目录和 Program Files 的读与执行照常。
- 不删特权，不加 restricting SID（不是 WRITE_RESTRICTED）。
- 令牌派生自 launcher 自己的主令牌，`CreateProcessAsUserW` 不需要 `SeAssignPrimaryTokenPrivilege`。
- 失败即终止：`OpenProcessToken`、`CreateRestrictedToken`、`CreateProcessAsUserW` 任何一步失败，launcher 以 163 退出，不退回宽令牌。
- 命令在 launcher 自己的 `KILL_ON_JOB_CLOSE` job 里启动，见 [job 收紧](2026-10-13-windows-sandbox-job-hardening.md)。

`scripts/build-sandbox-helper.mjs` 因此给 launcher 链接 `advapi32`（`gcc` 加 `-ladvapi32`，`cl` 加 `advapi32.lib`）。

## Alternatives considered

- **给工作区所在盘的根加 DENY** — 最强理由：不依赖令牌，对任何进程都有效，而且已实验确认显式 ALLOW 压得过继承的 DENY。没选是因为它要把继承 ACE 写到整卷每个对象：本机 `D:\` 有 1803133 个文件、200364 个目录，按每对象约 1–1.5 毫秒（`account.ts` 里 3 万个文件 30–47 秒的实测）估算要 33–50 分钟，撤销再来一遍，换新盘还要再弹 UAC，也没有量过对 OneDrive 的影响。
- **WRITE_RESTRICTED 令牌（加 restricting SID）** — 最强理由：不依赖盘上原有 ACL 写了什么，一次性挡住所有目录，包括第三方子树。没选是因为旧设计就是在这上面碰壁的（Git bash、WSL 起不来），srt 的 `ambient.rs` 注释也记录了它会因 LSASS 策略弄坏 Schannel。
- **把 `Users` 也变成 deny-only** — 最强理由：能同时堵住授给 `Users` 写权限的磁盘。没选是因为系统目录和 Program Files 的读与执行都靠 `Users` 的 ACE，沙箱里连 `cmd.exe` 都启动不了。
- **`DISABLE_MAX_PRIVILEGE` 删光特权、禁用登录 SID（srt 的 `token.rs`）** — 最强理由：收得更紧，srt 实测发现 seclogon 会把登录 SID 塞进令牌。没选是因为这套配置里令牌没有登录 SID，剩下的特权是标准用户那几项，没有可收的东西；以后若出现再加。

## Consequences

收益：
- 数据盘（盘根授 `Authenticated Users` 写权限的卷）上，工作区之外的目录沙箱写不进去。不改任何 ACL，不要 UAC，不依赖盘上对象数量。
- 失败不会悄悄退回宽令牌。

代价和已知缺口：
- 只挡写权限来自 `Authenticated Users` 的情形。盘根授给 `Users` 或 `Everyone` 写权限的卷、或管理员给沙箱账户自己授了写权限的位置，仍然可写。
- 依赖 `Authenticated Users` 才能读的位置，沙箱里读不到。本机没有遇到；`cmd`、`powershell`、`node` 的启动和退出码已验证。
- `Windows\Temp` 的写权限来自 `Users`，不受影响，仍可写（见 [ambient 写拒绝](2026-10-13-windows-sandbox-ambient-write-deny.md)）。
- 每条命令多一次令牌复制。
- 对照 srt 审查时说的“seclogon 会把登录 SID 塞进令牌”在这套配置里没有出现，那一条风险按实测应降级；没有登录 SID 不等于没有别的跨进程访问面，没有测。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 沙箱令牌里的组与特权 | 临时 live 测试，沙箱里跑 `whoami /groups`、`whoami /priv`，测完删除 | 见 Problem 段；输出没有存成文件 |
| 工作区内可写，同盘兄弟目录不可写 | `PI_SANDBOX_LIVE=1 npx vitest run _shared/sandbox/isolation.live.test.ts --testTimeout=180000`，用例 `writes inside the workspace but not into a sibling directory on the same drive` | 先红（改令牌前兄弟目录可写），改后通过 |
| 合法命令仍可运行、退出码透传 | 同一文件里 `still runs ordinary commands under the UI restrictions`：`cmd /c echo ok`、`powershell -Command exit 0`、`cmd /c exit 7`、`node -e process.exit(3)` | 通过 |
| 与 job、ambient 用例一起 | 同上整个文件，含强制分配失败的临时 helper 构建 | 通过，9 项（用入仓 helper 时 8 项通过、1 项跳过） |
| 沙箱整体单测 | `cd extensions && npx vitest run _shared/sandbox` | 通过，155 项（10 项跳过） |
| 常用工具链是否被受限令牌误伤 | 临时 live 测试在沙箱里依次跑 `git`、`npm`、`pnpm`、`python`、`node`、`powershell`、`curl`，再用同一个 helper 配入仓的旧 launcher（没有受限令牌）跑一遍对照 | 两边输出逐字相同。`git --version`、`npm`、`python`、`node` 起子进程和写文件、`powershell`、`curl` 正常；`git init` 和 `pnpm` 失败，见下 |

`git init` 失败：`unable to access 'C:/Users/rxstudio/AppData/Local/Atlassian/SourceTree/git_local/etc/gitconfig': Permission denied`。PATH 上先命中的是装在用户目录里的 SourceTree 自带 git，沙箱账户只对 PATH 目录本身有读权限，读不了它旁边的 `etc\gitconfig`。`pnpm` 失败：它从工作区往上找 `pnpm-workspace.yaml`，读 `C:\Users\rxstudio\pnpm-workspace.yaml` 被拒（探针的工作区建在用户 Temp 下，真实工作区不一定在那）。这两个都和令牌无关，是装在用户目录里的工具沙箱账户读不全的既有限制（srt 的已知限制里也有这一条）。

证据：`.agents/evidence/2026-10-13-windows-sandbox-restricted-token-authenticated-users/`（`tools-new-launcher.txt`、`tools-old-launcher.txt`）；其余 live 用例的输出在 `.agents/evidence/2026-10-13-windows-sandbox-job-hardening/`（`unit.txt`、`live-checked-in-helper.txt`、`live-fail-assign.txt`）。

没有覆盖：
- msys、`cargo` 等更大的工具链。
- 盘根授给 `Users` 或 `Everyone` 写权限的卷。
- 外部 U 盘、网络盘。
- 装在用户目录里的 `git`、`pnpm` 在沙箱里读不全配置，这是既有问题，另开一篇。

结果：通过（上面“没有覆盖”的项除外）。
