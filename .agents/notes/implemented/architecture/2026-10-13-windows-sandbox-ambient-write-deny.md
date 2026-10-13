# Agent Note: Windows 沙箱给系统自带的全员可写目录加写拒绝

Status: implemented

## Problem

文档和注释都说 PiSandbox“没有授权的地方写不进去”，实测不成立。PiSandbox 在 `Users` 组里，Windows 默认把写权限授给 `Users` / `Authenticated Users`，沙箱账户一路继承。

2026-10-13 在本机用 `workspace-write`、工作区在别处的情况下探测（命令：`cmd /c echo x>…`，工作区内写入作正对照，结果为可写）：

| 位置 | 结果 |
| --- | --- |
| `D:\` 下工作区的兄弟目录 | 可写 |
| `D:\OneDrive` | 可写 |
| `C:\ProgramData`、`C:\Users\Public` | 可写 |
| `C:\Windows\Temp` | 未能判定（用户读不了 PiSandbox 写的文件） |

数据盘的写权限来自盘根上的 `Authenticated Users:(OI)(CI)(IO)(M)`，由 [受限令牌](2026-10-13-windows-sandbox-restricted-token-authenticated-users.md) 处理。`ProgramData`、`Public` 等系统目录的写权限来自 `Users`，是本篇的对象。sandbox-runtime（srt）的 `ambient.rs` 把同一类目录列成“固定的全员可写系统目录”并加写拒绝。

## Decision

### 给固定的系统目录清单加可继承写拒绝

`windows/ambient.ts`。在下面这些存在的目录上，给 PiSandbox 加一条显式 ACE：`icacls <目录> /deny PiSandbox:(OI)(CI)(WD,AD,WEA,WA,D,DC) /C`（写数据、追加、写扩展属性、写属性、删除、删子项；读和遍历不动，只对这个账户生效）：

- `%ProgramData%`、`%PUBLIC%`
- `%SystemRoot%` 下的 `Tasks`、`tracing`、`Registration\CRMLog`、`System32\FxsTmp`、`System32\com\dmp`、`System32\spool\PRINTERS`、`System32\spool\drivers\color`，以及 `SysWOW64` 下的 `FxsTmp`、`com\dmp`、`Tasks`

清单与 srt 的 `ambient_deny_targets` 一致，**唯独去掉了 `C:\Windows\Temp`**：沙箱有意在用它，`account.ts` 专门给它授了列目录权，好让沙箱里的 `Remove-Item`、`readdir` 正常工作（见 [PiSandbox 账户](2026-10-02-windows-sandbox-pisandbox-account.md)），写拒绝会让里面的删除失效。

### 一次 UAC，只信 ACL 转储

`grantSandboxAccess` 在授权循环之后调用 `applyAmbientDenies`。缺的目录合并成一个提权脚本（一次 UAC）。`Start-Process -Verb RunAs` 拿不到子进程退出码，所以成功与否只看脚本写出的 `icacls` 转储里有没有 PiSandbox 的 DENY 行，这是和 Windows\Temp 的列目录授权同一个做法。确认过的目录在 `grants.json` 里记 `ambient:<小写路径>` = `DW1`，规则变了换成 `DW2`，旧记录就不算数。

拒绝 UAC、提权失败、有的目录改不了（TrustedInstaller 所有的目录可能改不动）都不算错：沙箱照常用，只是那些目录仍然可写；5 分钟内不再弹窗。`abort` 照常向上抛。

### 实现边界

逻辑都在新文件 `ambient.ts`；`account.ts` 只加了 `AccountIo.stampAmbient`、默认实现的一行接线、`grantSandboxAccess` 里一次调用，以及顶部注释改成真实情况。

## Alternatives considered

- **给工作区所在盘的根加 DENY** — 最强理由：能同时堵住数据盘，而且已用实验确认语义可行：在测试目录上给 PiSandbox 加继承的写拒绝、子目录显式授 `M`，子目录可写，父目录和它下面的兄弟目录被挡，外面的对照目录照常可写（显式 ALLOW 压得过继承来的 DENY）。没选是因为 `SetNamedSecurityInfo` 会把继承 ACE 写到整卷每个对象。本机 `D:\` 有 1803133 个文件、200364 个目录，按 `account.ts` 里实测的每对象约 1–1.5 毫秒估算要 33–50 分钟，撤销再来一遍；换工作区到新盘还要再弹 UAC。srt 同样因此没做。数据盘改由受限令牌解决。
- **改走 WRITE_RESTRICTED 令牌** — 最强理由：能整体堵住所有目录，包括第三方子树。没选是因为旧设计就是在这上面碰壁的（Git bash、WSL 起不来），srt 的 `ambient.rs` 注释也记录了它会因 LSASS 策略弄坏 Schannel。
- **只探测并告警，不改 ACL** — 最强理由：零风险。放在这一篇之外：`ConfinedArgv.enforcement` 在 UI 里没有任何地方被消费（只在 `runner.ts` 里赋值），“告知用户”没有现成通道，要新增跨文件契约，另议。
- **把 `Windows\Temp` 也列进去（srt 的做法）** — 最强理由：它是真实的全员可写目录，与其他项同类。没选的原因见上。

## Consequences

收益：
- 沙箱不能往 `ProgramData`、`Public` 等系统公共目录写文件，少了一类持久化和篡改的落点。
- 提权只发生一次，之后读 `grants.json` 即可；用户拒绝不会让沙箱不可用。

代价和已知缺口：
- `C:\Windows\Temp` 仍可写。
- 第三方在 `ProgramData` 下自带宽松受保护 DACL 的子目录，祖先上的拒绝管不到。
- TrustedInstaller 所有的目录用 `icacls` 可能改不动（srt 用 `SeRestorePrivilege`，这里没有），失败的那几个不会记录，下次冷却期过后会再尝试，可能再弹一次 UAC。
- 在 `ProgramData`、`Public` 里安装软件之类的沙箱命令会失败，这是预期。
- 探测时误在 `C:\ProgramData` 留下了一个文件 `pi-probe-1791894937411.txt`（PiSandbox 创建，当前用户无权删除，需要管理员）。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 目标清单、icacls 参数、转储解析、冷却、拒绝/失败不致命、`grantSandboxAccess` 接线 | `cd extensions && npx vitest run _shared/sandbox` | 通过，155 项（10 项跳过） |
| 真机：提权盖章后，沙箱写不进 `ProgramData`、`Public`，工作区内照常可写 | `PI_SANDBOX_LIVE=1 npx vitest run _shared/sandbox/isolation.live.test.ts --testTimeout=180000` | 通过：正对照、ProgramData、Public 三项 |
| 盖章结果 | `icacls C:\ProgramData`、`icacls C:\Users\Public` | 两处都有 `PiSandbox:(OI)(CI)(DENY)(W,D,DC)`；`grants.json` 记了 8 个目录（`Tasks`、`CRMLog`、`com\dmp`、`spool\PRINTERS`、`SysWOW64` 下的 `com\dmp` 和 `Tasks`，加 `ProgramData`、`Public`）；`tracing`、`FxsTmp`、`spool\drivers\color` 没有记录 |
| 分盘实验（上层 DENY + 子目录显式 ALLOW） | 临时 live 测试，测完删除 | 通过：子目录可写，父目录与兄弟目录被挡，对照目录可写；没有存成文件，结果记在上面的备选项里 |

证据：`.agents/evidence/2026-10-13-windows-sandbox-ambient-write-deny/`（`live.txt`、`acl.txt`）。

说明：提权那一次发生在跑 live 测试时，`confine` 走默认路径触发的，UAC 在本机放行；没有单独为它预先提示用户。`tracing` 等三个目录没有记录是因为转储里没看到 DENY（可能不存在，或所有者是 TrustedInstaller），下次冷却期过后会再尝试。

结果：通过。

相关：[job 收紧](2026-10-13-windows-sandbox-job-hardening.md)（同一轮对照 srt 的另一批改动）。
