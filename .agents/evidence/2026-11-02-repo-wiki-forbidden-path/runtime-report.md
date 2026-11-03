# Repo Wiki FORBIDDEN_PATH 运行时证据（只读）

采集时间：2026-11-02 14:13–14:15（Asia/Shanghai）。未重启、未取消任务、未触发模型或生成重试；SQLite 连接均使用 `mode=ro`。

## 结论

- 失败发生在 `note-pocock-flow` 的 **overview / 项目概览** 阶段，不是源码扫描阶段。prepare 已 prepared。
- 最新任务 `b80713ac-1c72-469d-b186-467ffb0177eb`：2026-11-02 **14:08:25.392 → 14:08:48.771 CST**，最终 `failed / partial`，计数为 published=0、failed=1、blocked=0。
- 错误只持久化为 `{code: FORBIDDEN_PATH, message: FORBIDDEN_PATH, retriable: false}`。检查过的任务表、执行账本、构建项及运行诊断日志**没有被拒工具参数或具体路径**；不推测具体拒绝路径。
- 当次已有 **6 次已结算模型请求**，17 次已结算工具调用；最后一个工具请求 `977005f2-8110-41c9-ba20-229a09fe6457` 在 14:08:48.748 创建、14:08:48.754 进入 dispatched，actual=null，紧接着 overview 于 14:08:48.768 失败。不是“没有调用模型”。
- 17 条读证据最后一条是 `notes/scripts/verify-agent-note-tree.ts:1–57`；这是成功读取的路径，不是被拒路径。

## 实际运行入口

| 对象 | 证据 |
| --- | --- |
| 主进程 | PID 38448，启动于 2026-11-01 21:01:42.447 CST；本仓库 `electron-agent/node_modules/.../electron/dist/electron.exe .` |
| renderer | PID 51688，命令含 `--app-path=D:\OneDrive\Project Files\Pi\electron-agent`，userData 为 `C:\Users\rxstudio\AppData\Roaming\electron-agent` |
| Repo Wiki host | PID 67628，启动于 2026-11-01 21:01:55.642 CST；明确加载 `D:\OneDrive\Project Files\Pi\electron-agent\out\main\repo-wiki-host.cjs` |
| host 文件 | `out/main/repo-wiki-host.cjs`，864,994 字节，最后写入 2026-11-01 21:01:42 CST |
| 版本入口 | `electron-agent/package.json` 的 version=0.3.0，main=`out/main/main.js` |

当前运行不是安装目录中的发布包，也不是 `out-local/main`。仅凭源码修改不会改变已运行 host。

## 原始来源与文档状态

- `C:\Users\rxstudio\AppData\Roaming\electron-agent\agent-data.db`：`agent_jobs`、`knowledge_build_items`、`knowledge_execution_requests`。
- `C:\Users\rxstudio\AppData\Roaming\electron-agent\repo-wiki\project-index.sqlite3`：项目 `f658fc02ef7446a202f5c339`，路径 `D:\System Dir\Downloads\note-pocock-flow`；pages、snapshots、generation_checkpoints 各 0 行。
- `D:\System Dir\Downloads\note-pocock-flow\docs\repo-wiki\zh`：存在 plan/project/migration 元数据与 `.execution-guard.json`、`.transactions`，未见发布 Markdown 页面。
- `C:\Users\rxstudio\AppData\Roaming\electron-agent\logs\runtime-diag.jsonl`：约第 9850 行（06:08:32.020Z）记录 `repoWiki_generate` 一次；9851 行记录 `admin.knowledge.start`。该日志是性能/调用计数，不记录此错误的具体路径。轮转日志 `.1` 同样未检索到 `FORBIDDEN_PATH` 或项目名。
- 检查当次时间窗内 `tool_audit` / `app_events` / `audit_events`，未找到对应工具参数或错误路径。`agent_audit` 有 job.create 元数据。
- 同目录 `runtime-ledger.json` 为从数据库抽出的脱敏账本，仅保留本失败任务、成功读路径、调用计数和用量；不含供应商配置、认证或存储令牌。

## 重启前活动状态（供主代理决策）

- 14:13 CST 查询：`agent_jobs` 全部为 completed/failed/cancelled；无 queued/running 等非终态。`service_tasks` 只有 1 条 completed；无待处理任务。
- `turns` 留有 58 条 running、5 条 queued 历史记录，但最新创建时间为 **2026-10-30 17:09:06.044 CST**，最新 started 为 17:11:13.671；均早于当前应用 11 月 1 日启动。不能把这些历史残留状态当成当前活跃会话。
- 当前应用启动后新增/启动的 turns：completed=1、failed=1、cancelled=1；无 running/queued。
- 14:13:45.500 CST 的 agent-host 采样：subagents active=0、inProcess=0、worker=0、resident=0、workerProcesses=0。
- 持久层与采样未见当前执行中任务，但普通交互会话的实时内存状态仍以主代理 UI/宿主状态为准；本调查没有授权重启。

## 下一步入口

1. 主代理结合源码中的已存在修复，判断是否只需重建当前 `out/main` host。
2. 获得用户重启授权后，通过原启动入口恢复应用，确认新 host 路径与文件时间后再做真实生成验证。
3. 真实重试会产生模型请求，应待用户同意；沿用 Repo Wiki 中该项目的生成入口或系统知识任务详情，不在本次只读调查中操作。
