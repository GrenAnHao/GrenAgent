# Agent Note: 沙箱里的命令限制网络访问

Status: proposed

## Problem

沙箱现在只管文件，不管网络。`SandboxExecutionPolicy.network` 的类型是 `"restricted" | "enabled"`（`extensions/_shared/sandbox/types.ts`），但没有任何平台实现 `restricted`：

- `resolvePreset.ts` 对所有模式都写死 `network: "enabled"`。
- macOS 的 seatbelt 配置里直接 `(allow network-outbound)`、`(allow network-inbound)`。
- Linux 的 `bwrapArgv` 没有 `--unshare-net`。
- Windows 的 `PiSandbox` 账户、受限令牌、Job 都没有任何网络限制（[受限令牌](../../implemented/architecture/2026-10-13-windows-sandbox-restricted-token-authenticated-users.md)、[Job 加固](../../implemented/architecture/2026-10-13-windows-sandbox-job-hardening.md)都只管本地对象）。

结果是：沙箱里跑的命令能读到的东西（工作区、macOS/Linux 上几乎整个文件系统、Windows 上账户能读的部分），都能被发到任意地址；也能下载并运行任意东西。文件沙箱限制了“写哪里”，没有限制“发去哪里”，对提示词注入造成的数据外传没有防线。

`safety/index.ts` 里的 `NET_TOOLS` 只是对**宿主进程里**的联网工具（网页抓取、MCP 等）做审批，不覆盖沙箱里的 shell。`web` 工具、MCP 都跑在宿主里，本篇的沙箱限制管不到它们。

另外要先知道的事实：这台机器上 Windows 防火墙三个配置文件（域、专用、公用）**都是关闭**的（`netsh advfirewall show allprofiles state`），`BFE` 和 `mpssvc` 服务在跑。所以“给 PiSandbox 加一条防火墙出站拒绝规则”在这台机器上不会生效，Windows 的方案不能依赖防火墙配置文件处于开启状态。

## Proposal

### 目标

把 `network: "restricted"` 做成真的：沙箱里的命令默认**不能**向外连接（也不接受入站），需要联网的命令走和现有“升权”相同的审批路径，用户批准后那一条命令以 `network: "enabled"` 运行。三个平台语义一致，实现各自独立。

### 各平台做法

- **macOS**：seatbelt 配置去掉 `network-outbound` / `network-inbound`，只允许 localhost（为后面的代理留口）。这是最简单的一个。
- **Linux**：`bwrap` 加 `--unshare-net`，新的网络命名空间里只有一个 down 的 `lo`。需要代理时再用 Unix socket 桥接（sandbox-runtime 的做法）。
- **Windows**：用 **Windows 过滤平台（WFP）**，在账户 `PiSandbox` 的 SID 上建持久过滤器：`FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6` 和 `ALE_AUTH_RECV_ACCEPT_V4/V6`，条件 `FWPM_CONDITION_ALE_USER_ID` 匹配这个账户，动作 block；再加一条优先级更高的 permit 放行回环（给代理用）。选 WFP 而不是防火墙规则，是因为过滤器直接挂在 BFE 上，不看防火墙配置文件的开关。过滤器装在现有的一次性管理员预配里（建账户的那一步，已经有 UAC 提升的流程，见[提权不落盘](../../implemented/bug-fix/2026-10-13-windows-sandbox-elevation-without-temp-files.md)），不新增提权入口。

### 联网命令

在 `restricted` 下，shell 工具遇到联网失败时，错误里写明“网络被沙箱限制”，模型可以按现有升权的方式申请以 `network: "enabled"` 重跑这一条命令；批准的粒度是单条命令，不是整个会话。Windows 上要让一条命令绕过 SID 级过滤器，只能换一个不受该过滤器约束的账户或令牌，这个机制要在验证里确定（见下）。

### 之后才考虑的：域名白名单

`restricted` 跑通后，可以像 sandbox-runtime 那样在宿主起一个本地代理，只放行白名单域名，沙箱里的命令靠 `HTTP_PROXY` 环境和“只能连回环”的限制出网。这是第二步，不在第一版。

## 要用户拍板的决定

1. 默认策略：`workspace-write` 默认 `restricted`，还是默认 `enabled`、只在 `read-only` 下限制？
   ➡️ `workspace-write` 默认 `restricted`，联网走审批。与文件沙箱“默认收紧、要用再批”一致；代价是 `npm install`、`git fetch` 每次都要批一次，所以应加“本会话内记住这个命令前缀”的选项（审批规则里已有 `rememberToolRule`）。
2. 第一版是只做“全断 + 单条命令批准”，还是直接做域名白名单代理？
   ➡️ 只做全断 + 单条批准。白名单代理要处理 HTTPS（只能按 SNI/CONNECT 域名放行）、非 HTTP 协议（git over ssh、数据库端口）、DNS，工作量是另一个量级。
3. Windows 过滤器放进一次性预配（需要管理员）还是放进每次运行？
   ➡️ 一次性预配。每次运行都动 WFP 要管理员，不现实。
4. 宿主里的联网工具（网页抓取、MCP）要不要同一个开关管？
   ➡️ 不要。它们是宿主进程自己联网，沙箱管不到；已经有 `NET_TOOLS` 审批。两件事分开写、分开说。

## Alternatives considered

- **Windows 防火墙规则（`New-NetFirewallRule -LocalUser <SDDL>`）** — 最强理由：官方、有 PowerShell 接口、不需要写 WFP 的 C 代码，规则可见于“高级安全 Windows 防火墙”，用户能自己查和改。不用是因为这台机器上三个配置文件都关着，规则不生效；让产品去开用户的防火墙是越界。WFP 过滤器不受这个开关影响。
- **AppContainer**（不给 `internetClient` 能力就没有网络） — 最强理由：网络隔离是内核级、不用装任何过滤器，也不需要管理员。不用是因为 AppContainer 的文件访问模型和现在 `PiSandbox` + NTFS ACL 的设计不兼容：对象要授权给 `ALL APPLICATION PACKAGES` 或具体包 SID，整套授权、回收、保护（几篇笔记）都要重做，且很多构建工具在 AppContainer 里不能运行。
- **环境变量 `HTTP_PROXY` 指向黑洞** — 最强理由：零系统改动。不用：只有守规矩的程序才读它，`curl --noproxy`、原始 socket、`git`（走 ssh）全部绕过，不是限制。
- **只靠审批（现状 + 提示）** — 最强理由：不改系统，不影响任何命令。不用：审批只发生在“工具调用”一级，模型写的脚本里 `curl` 一下就联网了，审批看不见。
- **仅 `read-only` 模式限制网络** — 保留为决定 1 的备选；它覆盖了最危险的“只读探索却能外传”，但 `workspace-write` 才是日常模式，也是最需要的地方。

## Acceptance criteria

- `restricted` 下，三个平台上沙箱命令对任意外部地址的 TCP 连接和 DNS 解析失败，失败信息可被识别为“网络受限”。每个平台用一条真机用例证明，并有“`enabled` 下同一条命令成功”的对照。
- `restricted` 下回环（127.0.0.1）仍可用，沙箱里本地起的服务和测试照常。
- Windows：在防火墙配置文件关闭的机器上也生效；卸载（删账户）时过滤器一并删除，不留孤儿过滤器。
- 联网命令的审批：批准后只对这一条命令生效，下一条命令仍是 `restricted`。
- `resolvePreset` 的默认值与决定 1 一致，并有测试。
- 现有沙箱测试和 live 用例不变。

## Risks

- **WFP 过滤器要写 C（或调 `fwpuclnt.dll`）并装持久过滤器**，装错了会影响整机网络（不是只影响 `PiSandbox`）。过滤器条件必须只匹配该账户的 SID；要有卸载路径，并在真机上先验证“用户自己的进程网络不受影响”。
- **Windows 上单条命令例外怎么做还没定。** SID 级过滤器对账户一视同仁，例外要么换账户（第二个无过滤器的账户，授权/回收要加倍），要么在过滤器里按进程路径或按令牌里的一个标记 SID 放行（`ALE_USER_ID` 条件是安全描述符，可以按令牌里的 SID 匹配，所以给“允许联网”的那一条命令的令牌加一个标记 SID，过滤器按它放行，这是更干净的做法，需要验证）。这是最大的未知，先做一个小的探针再决定。
- **审批摩擦**：默认 `restricted` 会让常见命令（包管理器、`git fetch`）变得烦；没有“记住”选项就会被用户关掉，等于没做。
- **只管沙箱里的命令。** 宿主进程里的联网工具、用户自己终端里的命令都不受影响，文档和 UI 不能写成“Pi 不联网”。
- 过滤器是持久的，Pi 被卸载或账户被手动删除后可能残留；预配要有幂等的清理。
- 域名白名单（第二步）会改变本篇“全断”的语义，届时要新开一篇并互链，不要改本篇的 Decision。

## 验证（计划）

| 项 | 怎么验证 | 看到什么算通过 |
| --- | --- | --- |
| Windows 探针（先做，决定上面的未知） | 管理员窗口里写一个 WFP 过滤器（只匹配 `PiSandbox` 的 SID），再用沙箱账户和用户账户各 `curl`/`Test-NetConnection` 一个外部地址；再试令牌里加标记 SID 的放行 | 沙箱账户被拒、用户账户不受影响；防火墙配置文件关闭时同样成立；标记 SID 放行可行或确认不可行 |
| 各平台 `restricted` | 扩展 `isolation.live.test.ts`：同一条联网命令在 `restricted` 失败、`enabled` 成功；回环可用 | 三个平台各一条通过；先红后绿 |
| 审批与单条例外 | `operations.test.ts` / `provider.test.ts` 加用例：批准一次只放行一次 | 通过 |
| 预设默认值 | `resolvePreset.test.ts` | 与决定 1 一致 |
| 卸载 | 预配的反向步骤后列 WFP 过滤器 | 没有残留 |
