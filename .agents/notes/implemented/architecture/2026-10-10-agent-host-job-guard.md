# Agent Note: agent-host 的子孙进程由主进程持有的 Job 收尾

Status: implemented

## Problem

agent-host 意外崩溃时，它拉起的 MCP 服务器、bash 后台进程、子代理的子孙进程会残留。libuv 只把直接子进程放进自己的 kill-on-close Job，孙进程静默脱离；直接子进程一死，进程树就断了，主进程事后按 pid 杀树也找不到孤儿。

## Decision

见 [docs/decisions/electron-agent/2026-10-10-agent-host-job-guard.md](../../../../docs/decisions/electron-agent/2026-10-10-agent-host-job-guard.md)。这里记维护时要守的契约：

- `pi-job-guard.exe`（`electron-agent/native/job-guard.c`）的协议：参数 `--pid <pid> [--wait-ms <ms>]`；stdout 第一行 `ready` 或 `error <step> <win32 error>`（退出码 2）；stdin 关闭是唯一的清理信号；清理后输出 `swept <n> kept <m>` 并以 0 退出。`jobGuard.ts` 只认这几行，改协议必须两边同改。
- Job 限制只有 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`。**never** 加 `SILENT_BREAKAWAY_OK`（孙进程会溜走），**never** 加 `KILL_ON_JOB_CLOSE`（helper 意外退出会连同正在跑的 agent-host 和用户打开的窗口一起结束）。
- helper **must** 以 detached 启动（`startJobGuard`），否则它在主进程的 libuv Job 里，主进程一崩它先死，没人收尾。
- 守卫 **must** 在 agent-host 拉起任何进程之前就位：`AgentProcessClient` 让 `ready` 等守卫。agent-host 也 **never** 在 `host.ready` 之前拉起子进程。
- 清理保留「有可见、有面积的顶层窗口的进程及它在 Job 内的子孙」。祖先链只沿 Job 内的进程往上找，Job 外的进程和被复用的 pid 不会让无关进程被保留。
- 改了 `job-guard.c` 要重新编译、提交 `native/bin/pi-job-guard.exe`（编译命令在文件头）。`jobGuard.test.ts` 的真机用例会拿入仓的 exe 跑一遍。

## Alternatives considered

- **在 agent-host 里登记子进程 pid，崩溃后主进程逐个杀树**——纯 Node，没有二进制。但 libuv 先结束直接子进程，树断了，孙进程找不到。
- **Job 带 KILL_ON_JOB_CLOSE、主进程持有句柄**——不需要常驻 helper。但正常退出也会结束 agent 命令打开的编辑器、浏览器，Node 也拿不到 Job 句柄。
- **koffi 等 FFI 在主进程里调 Job API**——不用多一个进程。要加原生依赖；主进程崩溃时仍需要独立进程收尾。

## Consequences

- **收益**：崩溃、正常关停、主进程崩溃三条路都会清掉残留的无窗口子孙进程。冒烟（`electron-agent/scripts/agent-host-smoke.mjs` 的崩溃阶段）：只杀 agent-host 后，cmd 包着的、不理会 EOF 的 MCP 服务器被清掉。
- **代价**：
  - 每个 agent-host 多一个常驻 helper。
  - 保留规则是启发式，隐藏窗口启动的后台程序会被结束。
  - 主动脱离 Job 的进程和沙箱账户起的命令不归它管。
  - 只覆盖 Windows。
- **重访信号**：用户反馈 agent 打开的程序在应用退出或崩溃后被关掉，就收窄清理范围；出现脱离 Job 的残留，就查是谁在用 `CREATE_BREAKAWAY_FROM_JOB`。

## Verification

- `cd electron-agent && npx vitest run electron/agentProcess/jobGuard.test.ts`：协议各分支，以及用入仓 exe 清掉经 cmd 拉起、已成孤儿的孙进程。
- `node scripts/agent-host-smoke.mjs --entry <localrun 构建>/main/agent-host.js`：最后的崩溃阶段要看到「守卫清掉了崩溃后残留的 MCP 服务器」。
