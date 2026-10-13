> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-12-own-bash-every-call-is-job.md](../../../.agents/notes/implemented/architecture/2026-09-12-own-bash-every-call-is-job.md) 维护；本文件冻结只读。

---
title: bash 改为自有实现：每次调用都是 job，前台超时转后台，界面跟随后台输出
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/sandbox/bashTool.ts
  - extensions/sandbox/bashJob.ts
  - extensions/sandbox/bashOutput.ts
  - extensions/sandbox/index.ts
  - extensions/jobs/service.ts
  - extensions/jobs/observer.ts
  - electron-agent/electron/app/jobsBridge.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/src/stores/jobLiveStore.ts
  - electron-agent/src/features/tools/BashJobTerminal.tsx
supersedes: extensions/2026-10-04-jobs-dsh-port-bash-background.md
superseded_by:
---

## 背景
上一篇把 DSH 的 jobs 体系和 `run_in_background` 搬了过来，但留了两处：模型没想到加 `run_in_background` 的长命令仍然整轮阻塞（那次 15 分钟的 Chromium 构建就是这样）；后台 job 的输出只有模型能经 `job_output` 看到，卡片上看不见。前者绕不开 pi 的 `createBashToolDefinition`：它的 execute 要等 `operations.exec` 结束才返回，没法在中途把进程交出去。pi 的 bash 在 CHANGELOG 里一直有修复，但我们早已用同名工具覆盖内置 bash、进程也走自己的 operations，只剩 execute 这一层还在复用。

## 决定
- bash 改为自有实现（`bashTool.ts`）。对外契约照 pi 1.0.2：工具名、`command` / `timeout` 参数、结构化结果 `{ output, truncated, full_output_path, exit_code, wall_time_seconds }`、截断提示 `Full output: <路径>`、`Command exited with code N` 标 isError、`Command aborted`、流式更新只放尾部、`PI_*` 会话环境变量、strict-prefer 约束采样。截断算法直接用 pi 导出的 `truncateTail`；累积器（`bashOutput.ts`）照抄 `output-accumulator.js`，另加按字节偏移的保留窗口作为 jobs 拉取源。`bashTool.test.ts` 是钉住这些格式的契约测试。
- 执行照 DSH tool-bash：每次调用先注册成 bash job，前台只是等它。等到 `timeout`（默认 120 秒，`BASH_FOREGROUND_TIMEOUT_SEC` 可改）仍在跑，就做一次消耗式读取把已有输出交给模型，附 `[still running after Ns; moved to background job bash-N]`，命令留在后台，结束时照常发通知。等待期间结算的，结果随本次调用交付并移除记录（awaited，不发通知）；调用被中止则停掉 job 并按 pi 抛 `Command aborted`；外部停止（界面、job_kill）抛 `Command stopped: <原因>`。会话 id 缺失或准入被拒（每会话 10 个）时退回 pi 原来的前台执行，`timeout` 到点杀。
- 界面跟随：注册表加 `onEvent`（registered / output / progress / stopping / settled / removed）。主进程 `jobsBridge` 用 `createJobObserver` 订阅，输出事件按 100ms 合并，以非消耗 `readAt` 取增量经 `pi://jobs` 推帧；卡片先用 `job_snapshot` 拿保留输出再接帧，按字节偏移对齐，断档重拉快照。bash 结果 details 带 `jobId` + `jobStartedAt`（进程内 id 重启后会复用），卡片据此跟随，底栏给状态与停止（`job_kill`，原因记 `cancelled by the user`，模型照常收通知）；job 不在了回退到工具结果文本。
- 上一篇里 jobs 注册表、tool-jobs 语义、通知格式的移植全部保留；本篇推翻的是其中「不做前台超时转后台」和「界面跟随不接」两点。

## 放弃的方案
- 继续包 pi 的 execute，让 `operations.exec` 在超时时提前 resolve：pi 会把半截输出当正常退出，退出码只能伪造，模型和 codemode 的结构化结果都会误判。
- 超时转后台只在模型显式给 `timeout` 时生效：长构建正是模型没想到设 timeout 的场景，默认关等于没做。
- 保持 pi 的默认无超时：前台不设上限就回到整轮阻塞；DSH bash-local 默认 120 秒，照搬。
- 界面轮询 job 列表（子代理面板的做法）：输出跟随要字节增量，轮询要么延迟大要么空转；推帧加快照兜底更省。
- 界面复用 `job_output`：那是消耗式读取，会抢走模型的游标，通知是否已送达的判断也跟着乱。
- 后台输出另开 dock 标签页：卡片就是这条命令所在的位置，先在卡片里跟随，入口只有一处。

## 后果
pi 后续对 bash execute 的修复不再自动生效，基线是 pi 1.0.2 的 `dist/core/tools/bash.js` 与 `output-accumulator.js`，升级 pi 时 diff 这两个文件，契约测试红了说明官方改了对外格式。`timeout` 的语义从「到点杀」变成「到点转后台」，要杀用 `job_kill`；挂死的命令会留在后台占名额，直到会话关闭或被停。pi 的 TUI 渲染器（`createShellRenderers`）没带过来，CLI 交互模式下 bash 走通用渲染。界面只跟得到主进程里的 job，goal / system worker 进程里的看不见。应用重启后 job 全部消失，卡片回退到工具结果文本。
