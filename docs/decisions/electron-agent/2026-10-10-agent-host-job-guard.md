> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-10-agent-host-job-guard.md](../../../.agents/notes/implemented/architecture/2026-10-10-agent-host-job-guard.md) 维护；本文件冻结只读。

---
title: agent-host 的子孙进程放进主进程持有的 Job，崩溃后清掉没有可见窗口的残留
status: active
date: 2026-10-10
scope: electron-agent
files:
  - electron-agent/native/job-guard.c
  - electron-agent/native/bin/pi-job-guard.exe
  - electron-agent/electron/agentProcess/jobGuard.ts
  - electron-agent/electron/agentProcess/agentProcessClient.ts
  - electron-agent/electron/main.ts
  - electron-agent/electron/agent/copyPiAdjacentAssets.ts
  - electron-agent/electron-builder.yml
supersedes:
superseded_by:
---

## 背景

agent-host 子进程（`2026-10-09-agent-host-child-process.md`）正常关停时会收掉 MCP 连接、后台任务和子代理；意外崩溃（例如 OOM）时这些收尾都不会跑。libuv 在 Windows 上把非 detached 的子进程放进它自己的 Job（kill-on-close），agent-host 一死，直接子进程会跟着被系统结束，但这个 Job 带 `SILENT_BREAKAWAY_OK`，孙进程不在里面：`cmd /c npx` 拉起的 MCP 服务器、bash 里起的开发服务器、子代理再拉起的进程都会成为孤儿。它们的父进程已经没了，主进程事后按进程树 `taskkill /T` 也找不到。冒烟里实测：只杀 agent-host，cmd 包着的、不理会 stdin EOF 的 MCP 服务器一直活着。

## 决定

主进程每拉起一个 agent-host，就启动一个 `pi-job-guard.exe --pid <agent-host pid>`（`electron-agent/native/job-guard.c`，MSVC 编译后入仓，构建时拷到 `out/main`，打包时 unpack）。

- helper 建一个 Job，只设 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`（允许显式 `CREATE_BREAKAWAY_FROM_JOB`，不允许静默脱离），把 agent-host 放进去，回一行 `ready`。之后 agent-host 拉起的进程都在这个 Job 里；libuv 那个 Job 里静默脱离的孙进程沿 Job 链往上走，停在这里。
- `AgentProcessClient` 拉起后立即建守卫，守卫就位才算就绪（agent-host 加载要一两秒，这期间不拉起任何进程）。agent-host 退出时，不论崩溃还是关停，都 release：关掉 helper 的 stdin。helper 等 agent-host 退出（最多 15 秒，超时就终止它），然后结束 Job 里剩下的进程，回一行 `swept <n> kept <m>`，主进程记进 `runtime-diag.jsonl`（`agent-host-sweep`）。`shutdown()` 等清理完成。
- 有可见、有面积的顶层窗口的进程，以及它在 Job 里的子孙，不结束。agent 命令用 `code .`、`start` 打开的编辑器、浏览器、终端是用户正在用的窗口。
- helper 以 detached 启动，不在主进程的 libuv Job 里。主进程崩溃时它的 stdin 断开，走同一条路收尾；那时 agent-host 已被主进程的 libuv Job 结束。
- 不设 `KILL_ON_JOB_CLOSE`：helper 自己被杀或崩溃时什么都不结束，正在跑的 agent-host 不受影响。
- 非 Windows、helper 缺失或分配失败时不守卫，记一行日志，照常运行。

## 放弃的方案

- 在 agent-host 里登记它拉起的每个子进程 pid，崩溃后主进程逐个 `taskkill /T`：不用原生代码。但 libuv 会先把直接子进程结束掉，进程树在主进程动手前就断了，孙进程找不到。
- 主进程定时快照 agent-host 的整棵进程树，崩溃后按快照杀：快照会过时（崩溃前刚起的进程不在里面），轮询 `Win32_Process` 本身也费 CPU。
- Job 带 `KILL_ON_JOB_CLOSE`，主进程关句柄就全部结束：最省事，也不用 helper 进程常驻。但应用正常退出时会连同 agent 命令打开的编辑器、浏览器一起结束，这些在改造前都能活下来；Job 句柄也必须由主进程持有，Node 没有接口，仍要原生代码。
- Job 完全不允许脱离：主动 `CREATE_BREAKAWAY_FROM_JOB` 的程序（少数守护进程、安装器）会直接启动失败。允许显式脱离，它们自己负责自己。
- 用 koffi 之类的 FFI 在主进程里直接调 Job API：要加一个原生依赖并跟着 Electron 升级。主进程崩溃时还要有人收尾，独立的小进程两件事一起做了。

## 后果

- 崩溃后残留的 MCP 服务器、开发服务器、shell、子代理进程会被清掉；冒烟里杀掉 agent-host 后，cmd 包着的、不理会 EOF 的 MCP 服务器被清掉（`swept 2 kept 0`）。正常关停也会再扫一遍，收掉关闭时没关干净的进程（例如 SIGTERM 只结束了 cmd，没结束 npx 拉起的 node）。
- 保留规则是启发式：用户在用、但没有可见窗口的后台程序（`Start-Process -WindowStyle Hidden` 起的）会被结束；挂着可见窗口的后台进程会被保留。
- 主动脱离 Job 的进程不受管。经 `CreateProcessWithLogonW` 起的沙箱命令也不在这个 Job 里，由沙箱 helper 自己的 kill-on-close Job 负责，它在启动器被结束时回收。
- 每次拉起 agent-host 多一个常驻的小进程（约 1MB 内存）。helper 是预编译二进制，改 `job-guard.c` 要在 VS 的 x64 Native Tools 命令行里按文件头的命令重新编译并提交 exe。全局 gitignore 若忽略 `*.exe`，仓库 `.gitignore` 已放行 `electron-agent/native/bin/*.exe`。
- 非 Windows 平台没有对应处理；那边的进程组清理另行考虑。
