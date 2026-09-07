# Agent 数据工作台实施总计划

> 执行者：使用 subagent-driven-development（当前会话按独立任务分工）或 executing-plans（内联逐项执行）。每项按红灯→最少实现→绿灯→规格/代码审查推进。

**目标：** 将已确认的六面板设计落地，并保留当前 AgentData、Markdown Wiki、任务清理和项目作用域行为。

**架构：** 公共界面与任务状态源先建立，Wiki 具名库与可信管理边界随后交付；Memory/Code 管理复用这些边界，最后收口聚合任务、审计、诊断与概览。

**技术栈：** Electron、React、TypeScript、Ant Design/Lobe、SQLite、现有 Pi SDK/AgentData RPC、Vitest。

设计依据：[已确认详细设计](../specs/2026-09-05-agent-data-workbench-design.md)。各阶段按用户指令执行；当前进度见下方记录。

**执行进度（2026-09-05）：** 第一至第四阶段已完成代码、自动回归与隔离界面验收。第四阶段交付用户/系统任务聚合、能力检查与重试、审计筛选导出、只读诊断和资源导航；最终后端/桥接 524 项、前端 394 项、扩展 85 项及 CLI 16 项测试通过，Electron 与 CLI 构建通过。独立复审无剩余 P1/P2。真实模型抽取、CodeGraph 索引写入与用户数据库迁移未执行，不能据此报告生产数据验收通过；类型检查仍有接续时的 37 项主进程、5 项渲染层错误，新增 0。未重启应用、提交或推送；详见第四阶段交付记录。

## 1. 阶段与依赖

| 顺序 | 实施计划 | 交付结果 |
| --- | --- | --- |
| 1 | [公共框架](./2026-09-05-agent-data-workbench-foundation.md) | 模块/面板保活、局部刷新、统一任务跟踪、视觉尺度 |
| 2 | [独立 Wiki](./2026-09-05-agent-data-workbench-wiki.md) | 具名库、项目关联、资料版本、人工页面、兼容登记与删除保护 |
| 3 | [Memory 与代码详情](./2026-09-05-agent-data-workbench-memory-code.md) | 可浏览/维护记忆、来源会话、代码与关系详情 |
| 4 | [任务、审计与诊断](./2026-09-05-agent-data-workbench-operations.md) | 两种任务只读聚合、重试/阶段、审计筛选、诊断和概览导航 |

阶段 3 依赖阶段 2 的可信管理调用和真实项目校验；阶段 4 依赖阶段 2 的任务目标元数据及阶段 3 的资源详情。本版不为提前并行而复制这些基础能力。

每阶段内可并行准备互不重叠的测试/组件；`runtime.ts`、`main.ts`、`ipc/register.ts`、`src/lib/agentData.ts` 由阶段负责人合并，避免多个实现者同时写入。

## 2. 执行前检查

在根目录执行以下只读命令，保存输出作为本轮基线：

```powershell
git status --short
git branch --show-current
git rev-parse --git-dir --git-common-dir --show-superproject-working-tree
```

当前检查结果为普通 checkout、分支 `codex/agentdata-extension-integration`，不是隔离 worktree。当前未提交内容包含用户修改与本任务已实现的 AgentData 功能，不能以干净 HEAD 替代工作状态。执行阶段如选择 worktree，先确认范围并保留当前未提交内容；本计划不创建 worktree、不 stash、不重置或提交现有改动。

依赖已经安装时不全量重装，尤其不恢复或重写用户已删除的锁文件。测试使用临时 SQLite、临时目录、可控模型/provider；不启动用户真实库做破坏性验收。

执行命令前确认对应项目 `node_modules/.bin/vitest.cmd` / `tsc.cmd`（非 Windows 使用无 `.cmd` 路径）存在；不存在时先确认依赖准备方式，禁止让 npm exec 静默拉取未固定版本的测试工具。本轮检查到 Electron 的 Vitest/TypeScript 和 CLI 的 TypeScript 入口存在，不承诺未来执行环境相同。

## 3. 跨阶段接口约定

### 3.1 面板和任务状态

- `AgentDataCenter.visible?: boolean`：ModuleContainer 首次访问后保活，模块隐藏时暂停请求。
- 各资源面板逐步接受 visible，保留筛选与草稿，不由父级 loading 卸载。
- `AgentDataTaskProvider.tsx` 同时导出 Provider 和无参 `useAgentDataTaskMonitor()`。
- 一期返回 `{jobs, error?, refresh, track(id), watchedTaskVersion}`；track 的回调闭包绑定操作开始时的面板，await 创建任务期间切标签不会改变归属；立即安排刷新，终态版本只增一次。
- 四期增加复合 `{source:'user'|'system', id}` 和 tasks，保留字符串 id 默认 user 的兼容方式。全程只有一个任务轮询源。
- 第三阶段新增 `onOpenSession(cwd,path)`，完整透传 App→ModuleContainer→AgentDataCenter→MemoryPanel，复用真实会话打开逻辑，不从 session ID 拼造磁盘路径。

### 3.2 管理与项目范围

- 二期交付 Runtime/Service 的 in-process `requestAdmin<T>(method,params={})`，仅 Electron 管理 IPC 调用；UI payload 的 admin 标志不具有授权含义。
- 二期交付项目绑定的 Agent endpoint，来源由主进程确认，不由客户端省略 workspace 获得全局访问。旧主 endpoint 只保留给内部服务。
- Wiki 的项目范围从可信调用上下文取得，解除关联同时约束新版与旧 workspace 兼容路径。
- `validateProject(workspace): Promise<string>` 由二期定义与 main 装配：realpath、目录存在、排除临时会话根；三期人工 Memory 管理复用。已有自动捕获和旧桶登记不因此被排除或删除。
- 不引入多用户 ACL、团队或云服务，也不顺带重做非 Wiki 现有 RPC 的权限策略。

### 3.3 Wiki 与任务元数据

- 二期用户资料抽取 kind 固定 `wiki.ingest`；旧 `wiki.sync` 和 `codegraph.sync` 保留。
- 未关联项目的库任务不能把 kbId 假装工作区路径。旧 `agent_jobs.workspace NOT NULL` 保留，非项目任务使用空串，并通过明确 target 表示所属知识库。
- 二期先添加可选 metadata JSON，并把 JobStore.create 改成显式 INSERT 列名。至少包含 `target:{type:'wiki',id:kbId}`、`payload:{kbId,sourceIds}`、可选 retryOf。
- 四期扩展同一 metadata，不加第二个同义列；TaskView.resource 来自 metadata.target，空 workspace 不呈现成项目。
- 元数据用于展示和重试描述；抽取 run 保存真实来源 revision 快照、取消状态和结果，不用一份可变 UI payload 代替执行记录。

### 3.4 旧数据

- 保留已经实现的 SQL→Markdown 兼容导出及原 SQL 备份。
- 具名库登记在该兼容步骤之后执行，只建立“原 workspace/bucket→kbId”映射；不再搬动或复制已有 Markdown。
- 已有临时会话桶也保留原访问范围和数据；“新建时选择真实项目”的校验不用于抹掉历史数据。
- 兼容导出或登记失败必须留下诊断，不能把失败桶作为空库迁移成功。
- 库名不是存储路径/授权标识，改名不改变 ID、目录与绑定。

## 4. 规格覆盖表

| 详细设计章节 | 负责阶段 |
| --- | --- |
| §3 导航、状态保留、尺寸 | 一期 F1–F6 |
| §4 概览 | 一期基础容器 + 四期 O6 真实资源汇总 |
| §5 Memory | 三期 Memory 任务 |
| §6 Wiki 全部交互 | 二期 Wiki 任务 |
| §7 代码索引 | 三期 Code 任务 |
| §8 任务 | 一期跟踪 + 四期 O1–O3 |
| §9 审计诊断 | 四期 O4–O5 |
| §10 新模型、兼容与范围 | 二期/三期契约 + 本总计划跨阶段约定 |
| §11 验收 | 各阶段回归 + 四期 O7 跨面板验收 |

不提前展示尚未完成后端的可执行操作；阶段交付说明必须区分“已可使用”与“下一阶段承接”。本设计中的可选关系图不影响基础调用关系列表验收，不作为新增图引擎工作。

## 5. 验证与交接规则

- [ ] 执行前运行当前有关模块的测试，记录已有类型/测试问题；不把基线问题混成新改动失败，也不静默忽略新增错误。
- [ ] 每个新行为有会失败的回归用例；创建接口之前的模块不存在是可接受红灯，但不能让拼写错误或错误夹具充当红灯。
- [ ] 高风险点需真实临时文件/SQLite/RPC：范围隔离、旧桶登记、删除门、人工版本/CAS、任务恢复。仅模型与外部 CodeGraph 进程边界使用替身。
- [ ] UI 以可观测输入、内容、按钮能力和导航状态断言，不仅检查组件是否渲染。
- [ ] 每阶段做规格和代码审查；共享文件合并后重新运行集成测试。
- [ ] 构建验证为 Electron `npm run build` 与 CLI `npm run typecheck` / `npm run build`；另行记录 Electron 主进程全量类型检查基线，不把根构建等同于全量类型检查。
- [ ] 只有实际运行的模型、GUI 或外部 CLI 才可报告通过；未运行项列明，不能用模拟数据宣称生产验收完成。
- [ ] 提交或执行真实迁移前确认用户授权及工作区范围。不要提交与本计划无关的修改。

## 6. 本轮计划检查

本轮只更新设计状态、新增四份分阶段计划和本索引。计划文件中的测试和实现代码是给执行阶段使用的说明，不表示这些接口现在已存在。实施时从第一阶段开始，推荐当前任务内分工执行并逐阶段审查；也可内联逐项推进，不必创建新的 Codex 任务。
