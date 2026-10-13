# Agent Note: Windows 沙箱回收闲置的修改权授权

Status: implemented

## Problem

每个工作区和每个会话的临时目录，第一次用到时都被授予 PiSandbox 的修改权（`icacls … /grant:r PiSandbox:(OI)(CI)M /T`），记录写进 `~/.pi/sandbox/grants.json`，此后**永不回收**。两个后果：

1. **沙箱账户能写的目录只增不减。** 任何一次沙箱命令都能写进以前用过的所有工作区。[受限令牌](../architecture/2026-10-13-windows-sandbox-restricted-token-authenticated-users.md) 管不到这一条：授权是直接给账户自己的，不是靠 `Authenticated Users` 继承来的。
2. **`grants.json` 无限增长**，里面大量记录指向早已删除的目录。

2026-10-13 在本机查（`grants.json` 共 271 条）：230 条修改权，其中 71 条指向已不存在的路径；还在的 161 条里，绝大多数是 `%TEMP%\sbx-*`——这一整天跑 live 测试建的工作区，测试从不删它们，每个都留着一条 PiSandbox 的修改权（共 182 个目录，一次完整 live 运行大约新留 25 个）。这部分是我们自己造成的。

## Decision

### 按闲置时间回收，不按会话结束回收

新文件 `windows/reclaim.ts`，`grantSandboxAccess` 在授权循环、探测、ambient 之后调用 `reclaimGrants`（只有 `AccountIo` 提供 `revoke` 时才跑，默认 io 提供）：

- **目录已不存在**：丢记录和它的使用时间，ACE 随目录一起没了。每条记录一次文件系统调用，所以每个进程一小时最多查一次（`prune`）。只对盘符路径判断，并且要盘本身还在、目录不在才丢：拔掉的 U 盘、断开的映射盘不当作目录被删；UNC 路径没有盘可问，不动。在用的目录不判断（键是小写的，大小写敏感的目录下查不到真实路径）。
- **在用的工作区和临时目录**：记下 `used:<key>` = 使用时间，超过 1 小时才重写一次，免得每条命令都写 `grants.json`。永不回收。
- **其他修改权记录**：没有使用时间的（升级前授的权），从现在起算，不一上来就撤销。闲置超过 14 天（`GRANT_MAX_IDLE_MS`）的撤销并丢记录；一次最多撤销 3 个，最久没用的先走。
- 不动：只读（`RX`）、遍历（`RAX`）、`reachable`、Windows\Temp 的列目录权（`RD1`）、`ambient:` 开头的系统目录写拒绝、盘根。

撤销是 `%SystemRoot%\System32\icacls.exe <目录> /remove:g PiSandbox /T /C /Q`，只摘掉账户名下的授权 ACE，拒绝类 ACE 留着。它在一个**后台的独立进程**里跑（`detached`，不等结果）：大目录树的撤销和授权一样慢，不能让正在执行的那条命令等着。记录先丢。撤销没做完的最坏结果是目录上残留一条 ACE，下次用到它时记录缺失，会按原有流程重新授权（`/grant:r` 是幂等的）。

**`/T` 会摘掉整棵树的 ACE，所以有两条保护：**
- 闲置的目录如果是某个在用目录（或近期 14 天内用过的目录）的祖先，不撤销，否则在用目录的授权被摘掉、记录却还留着 `M`，之后既不会被回收也不会重新授权，工作区永久不可写。比较时同时用路径本身和 `realpath`，这样 junction 或 subst 的另一种写法不会躲过去。
- 撤销一个目录时，它下面的所有记录（`RX`、`RAX`、`reachable`，以及它们的使用时间）一起丢，让它们下次用到时重新授权。

### 写 `grants.json` 时合并，不整体覆盖

`grants.json` 被多个进程共用，没有锁。原来整体覆盖写，会把别的进程刚撤销并丢掉的记录又写回去：ACE 没了，记录说还在，之后永远不会重新授权。现在 `mergeGrantChanges(before, after, onDisk)`：写之前重新读一次文件，只把这一次调用做的增删（含删除）叠加上去。窗口缩小到重新读和写之间，没有消除。

### 系统工具一律走绝对路径

`icacls`、`taskkill`、`net`、`powershell` 原来都是裸名字调用。Windows 对裸名字先在进程的当前目录里找可执行文件；Pi 的子代理 worker 和 CLI 版都可能在工作区里启动，沙箱命令往工作区根目录放一个 `icacls.exe`，下次授权或回收就会以真实用户身份运行它。实测：默认环境（没有 `NoDefaultCurrentDirectoryInExePath`）下，工作区里一个改名的 `whoami.exe` 被当成 `icacls` 执行了；这台机器碰巧设了这个变量，所以没被打中。

`elevate.ts` 加 `windowsSystemExe(name)`，所有调用改成 `System32` 下的绝对路径（`account.ts`、`operations.ts` 的 `taskkill`）；提权脚本里的 `icacls` 用 `[Environment]::GetFolderPath('System')`（`PS_ICACLS`）拼路径，不取环境变量。一个测试扫描这几份源码，不允许再出现裸名字的 `spawn`/`execFile`/`runCommand`。这是旧代码就有的洞，这次新加的撤销代码又多了一个触发点，所以一起修。

### live 测试自己清理自己建的目录

`isolation.live.test.ts` 里所有 `mkdtemp` 改成 `scratchDir`：建出来的目录登记下来，整个文件结束时统一删。工作区被授了修改权，测完不删就是永久授权。本机已有的 182 个残留目录手动删掉了（都是今天 05:10–07:19 之间建的、名字符合测试前缀）。回收的 live 测试把 `stampAmbient`、PATH 目录都关掉，并预先记上 Windows\Temp 的授权，不提权、不碰真实目录。

## Alternatives considered

- **会话结束时（`dispose`）立即撤销** — 最强理由：授权的生命周期和会话严格一致，不会有任何闲置授权。没选是因为每个新会话都要重新做一遍 `/T` 授权，大工作区 30–47 秒（`account.ts` 里的实测），而授权记录缓存的目的就是避免这个。
- **每次启动 Pi 时撤销所有授权** — 同上，而且常用工作区每次都要重来。
- **不撤销，只丢指向已删目录的记录** — 最强理由：零风险，不碰 ACL。没选是因为这解决不了第一个问题：还在的目录上的 ACE 照旧。这一步包含在本方案里，是最安全的那部分。
- **在命令里同步等撤销做完** — 最强理由：状态始终一致，没有“记录丢了 ACE 还在”的窗口。没选是因为大目录树会让一条普通命令卡几十秒。
- **只靠 `icacls /remove` 不加 `:g`** — 最强理由：更彻底。没选是因为会把账户名下的拒绝类 ACE 一起摘掉；这个命令不该比需要的更宽。
- **给 `grants.json` 加文件锁** — 最强理由：彻底消除读改写的竞争。没选是因为进程崩溃会留下锁，要处理过期；合并写已经去掉了最坏的那一种后果（把撤销写回去），先做这个。
- **记录里存原始路径，检查存在和撤销都用它** — 最强理由：不用把小写的键当路径用，大小写敏感的目录下也对。没做是因为要改 `grants.json` 的格式；目前靠“在用的目录不判断存在”和“撤销时同时比 `realpath`”规避。
- **给每个会话单独的沙箱账户** — 最强理由：授权天然隔离，用完删账户。没选是因为创建账户要提权（UAC），profile 等都要重来，代价远大于这里的问题。

## Consequences

收益：
- 沙箱账户能写的工作区数量有上限：只有最近 14 天用过的。
- `grants.json` 不再无限增长，也不再留指向已删目录的记录。
- 本机 `grants.json` 从 271 条降到 87 条。
- 沙箱代码里不再有“在工作区里放一个 `icacls.exe` 就能以用户身份执行”的路径。
- live 测试不再往用户的 Temp 里留带授权的目录。

代价和已知缺口：
- **14 天是个经验值，没有依据。** 隔了 14 天以上再回到一个大工作区，要重新付一次 `/T` 授权的时间。
- **`grants.json` 仍然没有锁。** 合并写之后，剩下的是重新读和写之间的一小段窗口；丢掉使用时间的最坏结果是一个仍在用的工作区被提前回收，下一条命令会重新授权。
- 撤销在后台跑，没有人确认它成功；失败了只会留 ACE，不会报错。
- 回收只处理修改权。工作区的祖先目录上的 `(RA,X)` 遍历权、PATH 目录上的读权限不回收。
- UNC 路径和 `\\?\` 开头的记录不满足“盘根下至少一级”，它们的修改权既不打使用时间也不会回收。
- 14 天内，沙箱账户仍能写这段时间内用过的所有工作区。把窗口缩到一个会话需要换掉“授权给账户”这个模型，不在本篇范围。
- `System32` 的绝对路径仍然来自 `SystemRoot` 环境变量（Node 里没有别的办法）。能改 Pi 环境变量的攻击者可以改它，也可以设 `NODE_OPTIONS` 直接在 Pi 里执行代码，修了也挡不住他。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| `revokeArgs`、`pathKey` 与 `grantKey` 一致、丢失效记录、不碰系统级记录、没有使用时间的先起算、闲置超时撤销并按最久没用的先走、在用的不撤销、使用时间刷新间隔、一次最多 3 个、只读/遍历/可达记录和盘根原样不动 | `cd extensions && npx vitest run _shared/sandbox/windows/reclaim.test.ts` | 通过；先红（模块不存在）后绿 |
| 审查指出的问题：闲置父目录不连带撤销在用的子目录、近期用过的子目录也受保护且同名前缀的兄弟目录不算子目录、撤销时丢掉下面所有记录、junction 的另一种写法、大小写敏感目录下不丢在用记录、不可用的盘不丢、UNC 不动、`prune: false` 不查文件系统、合并写保留别的进程的删除 | 同上 | 通过；全部先红后绿 |
| `grantSandboxAccess` 接线：丢失效记录并给在用目录记时间、撤销走 io、io 不撤销时什么都不做、读到的内容在写之前被别的进程删了一条时不写回去、检查已删目录一小时一次 | 同上 | 通过 |
| 系统工具走绝对路径：`windowsSystemExe`、`PS_ICACLS`、`taskkill` 的路径、源码里没有裸名字的 `spawn`/`execFile`/`runCommand` | `npx vitest run _shared/sandbox/windows/elevate.test.ts _shared/sandbox/operations.test.ts` | 通过；全部先红后绿 |
| 当前目录查找可执行文件确实会被打中 | 一次性探针：工作区里放改名的 `whoami.exe`，父进程清掉 `NoDefaultCurrentDirectoryInExePath` 后 `spawn("icacls")` | 裸名字：运行了 `whoami`（打印用户身份）；绝对路径：运行了真 `icacls`；变量设着时：运行了真 `icacls` |
| 沙箱整体单测 | `npx vitest run _shared/sandbox` | 通过，213 项（16 项跳过） |
| 类型检查 | 临时 tsconfig（strict、`noUnusedLocals`）对 `elevate.ts`、`ambient.ts`、`account.ts`、`reclaim.ts` 跑 `tsc` | 通过 |
| 真机：对一棵临时目录树真实授权、记录改成闲置超时、跑产品路径，后台撤销后整棵树的 ACE 为 0，在用的工作区仍有授权 | `PI_SANDBOX_LIVE=1 npx vitest run _shared/sandbox/isolation.live.test.ts -t "grant reclaim"` | 通过 |
| 真机：闲置的父目录下有在用的工作区，不被连带撤销 | 同上，用例 `keeps the ACE of a workspace that sits under a long-idle directory` | 通过：记录仍是 `M`，等 1.5 秒后工作区上的 ACE 仍在 |
| live 测试不再留目录，整个文件仍然通过 | 完整跑一遍 `isolation.live.test.ts`（`PI_SANDBOX_LIVE_ELEVATE=1`、`PI_SANDBOX_LIVE_GIT` 已设），前后数 `%TEMP%\sbx-*` | 前 0，后 0；14 项通过、2 项跳过；`C:\Users\Public` 上 PiSandbox 的写拒绝仍然只有一条 |

证据：`.agents/evidence/2026-10-13-windows-sandbox-grant-reclaim/`（`unit.txt`、`live.txt`、`cleanup-and-probe.txt`）。

没有覆盖：
- 14 天之后真正回收本机上还在用的 `~/.pi/agent/works/*` 工作区：时间没到，只验证了逻辑和对临时目录树的真实撤销。
- 撤销大目录树（几万个文件）的耗时和对命令延迟的影响：撤销在后台跑，没有量。
- 多个进程真实并发写 `grants.json`：只有构造出来的读写交错的单测。
- 大小写敏感目录、UNC、拔掉的盘：只有单测，没有在真机上造出这些情况。

结果：通过（上面“没有覆盖”的项除外）。
