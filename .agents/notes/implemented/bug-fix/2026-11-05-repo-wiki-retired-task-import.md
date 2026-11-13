# Agent Note: Wiki 历史迁移不调用退役任务 RPC

Status: implemented

## Problem

启动代码仍通过 AgentData `admin.jobs.list` 读取旧历史，该 RPC 已明确退役，每次启动都报 `METHOD_NOT_FOUND`。现场共享库的 `agent_jobs` 表已不存在。Wiki 现有 `tasks.sqlite` 独立运行，不能用恢复共享任务管理面的方式修迁移。

另一个启动错误来自 Electron 38.8.6 分发目录缺少 `chrome_100_percent.pak` / `chrome_200_percent.pak`；同版本缓存 ZIP 中两文件完整，其余分发文件均存在。

## Decision

启动时只读打开旧共享库，旧文件或旧表不存在时返回零；旧表仍在则沿用 JobStore 的只读映射与 WikiTaskStore 的幂等导入，只复制 `repoWiki.generate`。导入后再落定孤儿任务，避免旧 running 记录被导入为永久运行。错误仍记录，不隐藏损坏的数据库。Electron 缺失资源只从版本一致的本机缓存补齐，不重装或替换其他文件。

历史归属：[共享 Runtime](../../implemented/architecture/2026-08-31-self-owned-agent-data-runtime.md)与[持久任务](../../implemented/architecture/2026-11-01-repo-wiki-agentdata-durable-tasks.md)部分重叠，保留其历史数据和独立执行合同；[解耦评估](../../proposed/architecture/2026-11-03-agentdata-lightweight-decoupling-review.md)的未完成范围不变。本项只修启动迁移，不新增任务管理入口。

## Alternatives considered

- **删除历史导入**：最简单且能消除告警，但仍有旧表的安装会丢失历史迁移入口，不采用。
- **恢复 `admin.jobs.list`**：能复用原调用方，但重新开放已退役的共享管理面，与当前所有权边界冲突，不采用。

## Verification

- 启动接线回归修复前失败，定位到 `main.ts` 仍调用 `admin.jobs.list`；修复后接线要求只读迁移先于 `settleOrphans()`。
- `npx vitest run electron/wikiService/legacyTaskImport.test.ts electron/app/repoWikiTaskPortWiring.test.ts electron/wikiService/taskRecovery.integration.test.ts electron/wikiService/taskPort.test.ts`：4 文件 16 项通过，覆盖缺文件、缺表、只搬 Wiki、保留全部字段、幂等、不改源库，以及孤儿收敛。
- `npx tsc --ignoreConfig --noEmit --target es2022 --module esnext --moduleResolution bundler --strict --skipLibCheck electron/wikiService/legacyTaskImport.ts electron/wikiService/legacyTaskImport.test.ts`：通过。
- 现场源库只读检查，目标使用临时库：返回 imported=0、targetCount=0，没有退役 RPC 或缺表报错，未写用户数据。
- `npm run test:repo-wiki-flow`：9 文件 49 项通过，含专用类型检查、真实 Wiki OS child 和固定 provider。
- 从缓存 `electron-v38.8.6-win32-x64.zip` 恢复两个缺失文件（167306 / 258328 字节），缓存与安装版本同为 38.8.6；未替换其余文件。隔离隐藏 Electron 窗口加载本地页面并截图的冒烟，修复前稳定出现资源加载错误，修复后输出 `RESOURCE_SMOKE_OK 38.8.6`、stderr 为空、退出码 0；未启动用户 Pi。
- 2026-11-05 用户对话任务完成并完整退出 Pi 后，确认 Pi 进程为零，`npx electron-vite build --mode localrun` 成功，开发产物更新。此前运行中构建被 `pi-job-guard.exe` 的 EBUSY 阻断，未强杀进程，按用户要求暂停后才重建。

## Consequences

保留有旧表安装的历史迁移能力，同时退役接口保持关闭。旧库迁移仍是同步启动操作，仅用于已有历史，不扫描模型正文或恢复真实模型任务；损坏的源库仍产生可诊断错误。资源修复仅作用于本机依赖安装，不改变 Electron 版本或仓库依赖声明。

真实 Pi 启动、聊天和 Wiki 模型生成由用户重启后验证，开发构建与离线回归不替代该验收。此前[线程 RPC 修复](2026-11-05-thread-rpc-text-validation.md)记录的完整主进程类型检查缺口仍存在，本次只通过上述定向类型检查与开发打包。
