# Agent Note: Windows 沙箱让账户对工作区的配置目录只读

Status: implemented

## Problem

工作区对 PiSandbox 开放写入（`(OI)(CI)M`），工作区里有几个目录是别的程序会在沙箱**之外**读取并照着执行的：Pi 启动时从 `<工作区>/.pi/extensions/` 加载扩展，编辑器会读 `.vscode/`、`.idea/`。沙箱里的命令能改这些目录，等于能让下一次以真实用户身份运行的程序执行它放进去的东西。受限令牌和系统目录的写拒绝管不到这一条，因为这些文件就在被授了修改权的工作区里。

## Decision

### 只保护三个目录：`.pi`、`.vscode`、`.idea`

新文件 `windows/protect.ts`。`grantSandboxAccess` 在 `workspace-write` 模式下、授权循环之后，对工作区里**已经存在**的这三个目录（不是链接、真是目录）依次做三步，`icacls` 的每一步都带 `/L`（名字在检查之后可能被换成 junction，`/L` 让它只动链接本身）：

1. `/setowner <真实用户> /T`：所有者自带改 ACL 的权利。沙箱里自己建出来的目录（`mkdir .vscode`）归 PiSandbox 所有，不先拿回所有权，它一条 `icacls … /grant PiSandbox:F` 就能把保护撤掉。
2. `/inheritance:d`：继承来的授权变成显式副本。
3. `/grant:r PiSandbox:(OI)(CI)(RX)`：把账户的 Modify 副本整个换成读和执行。`:r` 是原子替换，账户任何时候都不会处于“一点权限都没有”的状态，所以中途被杀也不会把 git 之类的东西弄坏。

结果：没有写权限、没有 `DELETE`，改、追加、新建、删、改名都不行；工作区根授的是 Modify，不含 `FILE_DELETE_CHILD`（icacls 的 `M` 是 `0x1301BF`），也没法靠父目录删掉或改走它们。读不受影响，用户之后往里加的东西继承 RX，沙箱读得到，用户自己的账户不受影响。

### 记录与重做

`grants.json` 里记 `protect:<工作区键>` = `PR3:.pi@<标识>,…`，标识是 NTFS 文件索引。目录被删了重建，标识就变了，下次命令重新保护。逐个目录做、做成一个记一个；失败（不是 abort）后停下，同一进程 5 分钟内不再试；做完之后再检查一次这个目录还是原来那个，被换了就不记。每一步给 10 分钟超时（`.pi` 里文件很多时遍历要时间）。

工作区的修改权被重新授予时（记录缺失、回收之后再用、授权给上级目录），`/T` 会把账户的 Modify 写回到下面每个对象上，包括受保护的：所以授 Modify 时，把这个路径**以及它下面所有工作区**的 `protect:` 记录一并丢掉，同一次调用里立刻重新保护。回收（[回收闲置授权](2026-10-13-windows-sandbox-grant-reclaim.md)）撤销或丢弃一个工作区时，它的 `protect:` 记录一起丢。

### 刻意不做的

- **`.git`（`config`、`hooks`）。** 先做了完整的一版（`.git` 目录自己去掉 `DELETE`，`config`、`hooks` 只读，git 日常操作实测正常），独立审查后撤掉：`.git` 里要能建锁文件，所以沙箱就能往里新建任意文件名，而 git 会因为某个新建的文件改去别处读配置和 hooks，保护 `.git/config` 就绕得过去；堵上要往用户的 `.git` 里写文件。另外沙箱里自己 `git init` 出来的仓库、`.git/modules`、`.git/worktrees`、`core.hooksPath` 指向的目录都不在范围里。宿主在工作区里自动跑 git 的地方（文件浏览器的 `git status`）要自己加固，不能指望这里。
- **单个文件**（`.git/config`、`.gitmodules`、`.mcp.json`）：用户的 git 和编辑器“写临时文件再改名”保存时会把保护换成继承来的 Modify，而记录还说已保护，之后不会重做。
- **`.claude`**：里面可能有整套 worktree，要遍历成千上万个文件；只保护它的子项又得把 `.claude` 本身锁成不可改名。Claude Code 的 hooks、commands 目前不在保护范围内。

### 同一批里顺带修的

- **外层 PowerShell 偶尔崩溃时重试一次。** 完整跑 live 套件时，外层不提权的 `powershell.exe` 5.1 在约 400 毫秒内自己崩了一次（退出码 `0xC0000005`，`System.AccessViolationException`），什么也没报告，让提权失败。每个提权脚本都可以安全跑两遍，所以 `runElevated` 对这种崩溃（NTSTATUS 退出码，不含超时、普通失败、用户取消）重试一次。
- 文件命令的输出在中文系统上是 GBK，测试里按 GB18030 解码才能断言“拒绝访问”。

## Alternatives considered

- **显式拒绝（deny）写和删除** — 最强理由：不动继承，工作区的修改权原样保留，改动最小，第一版就是这么做的。实测不行：只要拒绝了 `DELETE`，这个账户连读这个文件都被拒（cmd、node、PowerShell 都是），而不拒 `DELETE` 又挡不住删除和改名。
- **保护 `.git`** — 见上，做出来了，但绕得过去，撤掉。
- **把没有的目录提前建出来（`.pi`、`.vscode`）** — 最强理由：能堵上“沙箱抢先创建”这个口子。没做是因为要往用户的工作区里建目录；`.pi` 是 Pi 自己会建的，实际上大多数工作区第一次会话后就有了。
- **拒绝工作区根上“创建名为 `.pi` 的条目”** — ACL 做不到按名字拒绝创建。
- **给保护记录一个全局版本，改了规则就全部重做** — 已经有：`PROTECT_VERSION`，值里带版本，版本不对就当作没记录。

## Consequences

收益：
- 已经存在的 `.pi/`、`.vscode/`、`.idea/` 沙箱改不了、删不了、改不了名，也没法把权限加回来；沙箱自己建出来的同样被收回。
- 读不受影响；git 日常操作（add、commit、log、checkout -b、status、读写配置）在有受保护目录的工作区里照常。
- 保护被工作区的重新授权冲掉时会自动重做，被删了重建的目录也会重新保护。

代价和已知缺口：
- **只能保护已经存在的目录。** 不存在的 `.pi` 沙箱可以抢先建出来；保护之前放进去的内容保护不了，只是之后改不动。
- **`.git`、单个配置文件、`.claude` 没有保护**，原因见上。这意味着“沙箱改 `.git/config` 让宿主的 git 去执行点什么”这条路没有被堵上，需要在宿主一侧自己处理（例如文件浏览器跑 `git status` 时关掉 `core.fsmonitor`），见[宿主自己在工作区里跑 git 时加固](2026-10-13-host-git-hardening.md)；那一篇也写明了宿主侧封不住的部分（先列驱动再执行的竞态）。
- 保护之后没有撤销路径（回收、关沙箱都不恢复继承），之后父目录 ACL 的改动不再传到这些目录。
- 工作区根目录本身仍然能被改名；根目录的 Modify 包含对自己的 `DELETE`。
- 目录很大时第一次保护要花时间（每一步都遍历整个目录）。
- 工作区里已经被授了修改权的人，在 14 天回收期内的其他窗口仍能写这些目录之外的所有东西，这不是本篇要解决的。
- 在 PowerShell 工具（pwsh 7 父进程）里启动整套 live 测试时，同一条提权用例也出现过一次失败，同样的用例在 bash 里（包括模拟 pwsh 7 的 `PSModulePath`）通过；差异没有查清。重试之后两次完整的 bash 运行都通过。命令行改用 bash 统一执行。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 目标列表（只列存在的三个目录、带标识、删了重建标识变、链接和普通文件不算、`.git` 和单个文件不在其中）、三步命令的顺序与 `/L`、没有 `/remove:g` 和 `/deny`、逐个保护并记录、版本变了重做、失败时保留已做成的并冷却、保护过程中被换掉就不记、abort 照常抛 | `cd extensions && npx vitest run _shared/sandbox/windows/protect.test.ts` | 通过；先红后绿 |
| `grantSandboxAccess` 接线：写模式才保护、授 Modify 后重新保护、授上级目录时嵌套工作区的记录一并丢、只读模式和不支持保护的 io 什么也不做 | 同上 | 通过 |
| 回收联动：工作区消失时丢 `protect:` 记录、撤销时一并丢、不把它当目录去撤销 | `npx vitest run _shared/sandbox/windows/reclaim.test.ts` | 通过；先红后绿 |
| 外层崩溃重试：崩溃退出码重试一次、再崩就报错、超时和普通失败不重试、用户取消不重试 | `npx vitest run _shared/sandbox/windows/elevate.test.ts` | 通过；先红后绿 |
| 沙箱整体单测与类型检查 | `npx vitest run _shared/sandbox`；临时 tsconfig（strict、`noUnusedLocals`）跑 `tsc` | 241 项通过；`tsc` 通过 |
| 真机，沙箱账户的真实行为：写、新建、删、改名、把权限加回来都被拒（输出是“拒绝访问”）；读照常；普通写入照常 | `PI_SANDBOX_LIVE=1 PI_SANDBOX_LIVE_ELEVATE=1 PI_SANDBOX_LIVE_GIT=… npx vitest run _shared/sandbox/isolation.live.test.ts` 的 `protection of workspace configuration` | 通过 |
| 真机，沙箱自己建的目录：被收回所有权，它再想把权限加回来也不行 | 同上 | 通过；去掉 `setowner` 一步后这条失败（沙箱改写了 `.vscode` 里的文件），还原后通过 |
| 真机，用户账户不受影响、之后加的文件沙箱读得到；目录删了重建被重新保护；工作区被重新授权后重新保护（用一个显式 `(R)` 的标记文件证明 `/T` 确实跑过，并恢复 `grants.json`）；日常 git | 同上 | 通过 |
| 整个 live 文件，从 bash 连跑两次，前后数 `%TEMP%\sbx-*` | 同上 | 两次都是 20 项通过、2 项跳过；前后都是 0 |
| `.git` 完整保护的传播成本（量过，才决定的取舍） | 造一个 3 万文件的 `.git` 计时 | 授 Modify 的 `/T` 18.7 秒；`.git` 每一步额外 2.4–2.7 秒 |

证据：`.agents/evidence/2026-10-13-windows-sandbox-workspace-config-protection/`（`unit.txt`、`live-run1.txt`、`live-run2.txt`、`checks.txt`）。

没有覆盖：
- 非常大的 `.pi` 或 `.vscode` 目录的保护耗时：没有量，每一步有 10 分钟超时。
- 并发：两个会话同时保护同一个工作区，只有单测里的顺序，没有真机的并发。
- `.git` 的保护（见上，没做）。
- 非 NTFS 的卷：ACL 不适用。

结果：通过（上面“没有覆盖”和“代价和已知缺口”里的项除外）。
