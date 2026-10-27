# Agent Note: Windows 沙箱工作区授权不再 5 秒超时，也不再带 /T

Status: implemented

## Problem

工作区 `D:\OneDrive\Project Files\mcp\JSReverser` 里每一条受限 bash 都报「沙箱没有启动」：

```
failed to grant PiSandbox access to D:\OneDrive\Project Files\mcp\JSReverser: timed out granting C:\Windows\System32\icacls.exe
```

`grantSandboxAccess` 给工作区授修改权用的是 `icacls <工作区> /grant:r PiSandbox:(OI)(CI)M /C /T`，经 `runCommand` 跑，默认超时 5 秒。这个工作区有 70,533 个文件（`node_modules` 占 68,534），icacls 走不完就被 `taskkill` 杀掉。授权失败不写 `grants.json`，下一条命令从头再来，又是 5 秒被杀，所以是「总是」失败，不是偶发。半途被杀还会在树上留下一部分 ACE。

同一个 5 秒也卡着 PATH 里用户目录下的 `RX` 授权（同样带 `/T`）：那边失败被静默跳过，代价是每条命令多等 5 秒（[PowerShell 静默从 C:\ 开始](2026-10-13-windows-sandbox-shell-outside-workspace.md) 里记过、没修）。旧笔记里写过「大工作区 30–47 秒」，保护步骤为此给了 10 分钟，工作区授权本身漏了。

把超时调到 10 分钟后实测，首次授权 236 秒才完成。慢在 `/T` 本身：同一棵树上重放同一条授权，带 `/T` 320 秒，不带 21 秒。`/T` 让 icacls 对每个对象各写一次 DACL，而每次写入又会让 Windows 把可继承项往这个对象的子树再传一遍；只写根目录时，系统把继承项沿树传一遍就完。

## Decision

### 修改权 / 只读授权只写根目录，靠继承下传

`icaclsGrantArgs` 不再出现 `/T`，`M` / `RX` 都是 `PiSandbox:(OI)(CI)<权限>` 只写在目标目录上，`propagate` 参数随之从 `icaclsGrantArgs`、`grantTimeoutMs` 和 `AccountIo.grant` 上删掉。启用了继承的子孙对象由系统补上 `(I)` 继承项。关掉了继承的对象拿不到这条授权，沙箱里写它会是一次普通的沙箱拒绝，可以按现有流程升权。

### 整棵树的授权给 10 分钟，并且在进程内共用

- `grantTimeoutMs(rights)`：`M` / `RX` 10 分钟（和保护步骤同一个预算），遍历祖先的 `RAX` 30 秒，其余（Windows\Temp 的列目录权）5 秒。
- 整棵树的授权经 `shareInFlight` 走：同一进程里并行的几条命令对同一个目标只跑一个 icacls，大家等同一个结果。这次运行不挂调用方的 abort 信号，调用方取消只是不再等它，icacls 照样跑完，免得半途被杀、下次从头再走一遍。

### 重新授权之后仍然重新保护配置目录

授 `M` 时仍然丢掉这个路径和下面所有工作区的 `protect:` 记录，立即重新保护。理由变了：以前是 `/T` 会把 Modify 写回受保护目录；现在授权不进关掉继承的目录，但回收用的 `/remove:g /T` 会把保护留下的 RX 一起摘掉，记录缺失的重新授权正好跟在回收后面，不重新保护的话沙箱连 `.pi` 都读不了。[配置目录保护](2026-10-13-windows-sandbox-workspace-config-protection.md) 那篇的这段已同步改。

## Alternatives considered

- **只把超时调长，保留 `/T`** — 最强理由：权限语义一点不变，树上每个对象都有显式授权，连关掉继承的目录也覆盖。没选是因为首次授权要四五分钟（实测 236 秒），用户在大工作区的第一条命令像卡死；并且 `/T` 会把账户的 Modify 写进关掉继承的目录，这本来就是保护那边要额外补救的副作用。用户在两者之间选了去掉 `/T`。
- **授权放到后台，命令先在没有写权限的状态下跑** — 最强理由：命令完全不用等。没选是因为第一条命令会在工作区里被拒写，模型看到的是假的沙箱拒绝，还可能因此去申请升权。
- **按目录逐个授权、跳过 `node_modules` 之类的大目录** — 最强理由：更快。没选是因为构建和安装依赖正要写这些目录，跳过就等于工作区一半不可写。
- **不共用，每条命令各跑各的 icacls** — 最强理由：实现简单，取消语义直接。没选是因为模型常常并行发几条 bash，大工作区上就是几个 icacls 同时遍历同一棵树。

## Consequences

收益：
- JSReverser 这类大工作区不再每条命令都报沙箱未启动；首次授权从 236 秒降到 22 秒，之后走缓存 7 毫秒。
- PATH 里大目录的 `RX` 授权不再每条命令白等 5 秒。
- 树上留下的是继承项，不再是每个文件一条显式 ACE。

代价和已知缺口：
- 首次进一个大工作区，第一条受限命令仍要多等十几到几十秒，界面上只看到命令在跑。
- 关掉继承的子目录（除了我们自己保护的配置目录）对沙箱不可写。用户仓库里很少见，碰上了是一次可升权的沙箱拒绝。
- 用旧代码（`/T`）授过的工作区上还留着逐个文件的显式 ACE，不去清，回收时 `/remove:g /T` 照样摘得掉。
- 回收的 `/remove:g /T` 仍然逐个对象写，70k 文件实测 284 秒。它在后台独立进程里跑，不挡命令，但这段时间里会和同一目录的重新授权交错。没有改，因为去掉 `/T` 后旧的显式 ACE 摘不干净。
- 调用方取消后后台跑完的授权不写记录，下一条命令会再遍历一次。
- 跨进程（子代理 worker、CLI）的并行授权不共用。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 授权参数不带 `/T`；超时按权限分档；并行调用共用一次运行、调用方取消只停自己的等待、结束后下次重新跑 | `cd extensions && npx vitest run _shared/sandbox/windows/account.test.ts` | 通过；超时与共用两项先红后绿 |
| 沙箱整体单测 | `npx vitest run _shared/sandbox` | 通过，244 项（26 项跳过），`unit.txt` |
| 类型检查 | 临时 tsconfig（strict、`noUnusedLocals`）对 `account.ts` 跑 `electron-agent` 的 tsc | 通过 |
| 不带 `/T` 时继承能到深层文件、关掉继承的目录拿不到 | `inherit-check.ps1` 造临时树 | 深层文件 `PiSandbox:(I)(M)`，关掉继承的目录里没有 PiSandbox，`inherit-check.txt` |
| `/T` 的代价 | `timing.ps1` 在 JSReverser 上重放同一授权 | 不带 21.3 秒，带 320 秒，`timing.txt` |
| 真机产品路径：只调超时（仍带 `/T`） | `live-grant.mts`，默认 io 对 JSReverser 调 `grantSandboxAccess` | 236 秒完成并记 `M`，第二次 7 毫秒，`live.txt` |
| 真机产品路径：去掉 `/T` 后从没授过权的状态开始 | `reset-workspace.mts`（按回收方式撤销并删记录）+ `live-grant.mts` | 首次 22 秒、记 `M`，第二次 7 毫秒，`node_modules/typescript/package.json` 上 `PiSandbox:(I)(M)`，`reset.txt` / `live-after.txt` |
| 真机隔离、回收、配置目录保护（重写了「回收后重新授权要重新保护」：先按回收方式 `/remove:g /T`，确认 `.pi` 上没有 ACE，命令后 `src` 有 `(I)(M)`、`.pi` 恢复 RX 且写入被拒） | `PI_SANDBOX_LIVE=1 npx vitest run _shared/sandbox/isolation.live.test.ts -t "blocks writes\|grant reclaim\|protection of workspace configuration"` | 8 项通过（git 那项需 `PI_SANDBOX_LIVE_GIT`，跳过），`live-isolation.txt` |

证据：`.agents/evidence/2026-10-22-windows-sandbox-grant-timeout/`。

没有覆盖：在 GrenAgent 界面里对 JSReverser 发 bash 的端到端操作（产品路径的 `grantSandboxAccess` 已在真机上跑过）；跨进程并行授权；需要提权的 live 用例（Windows\Temp 列目录权、账户重建）这次没动相关代码，没跑。

结果：通过。
