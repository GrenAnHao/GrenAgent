# Agent Note: 清理退役 Wiki 在项目上下文和增强链路的残留

Status: implemented

## Problem

项目上下文仍调用已删除的 Wiki API，导致有效的 CodeGraph 状态也无法显示。提示词增强把 Wiki 工具列给模型，但后端已退役这些 RPC。退役宿主的接线、测试和一次性维护脚本还留在活跃目录。

## Decision

项目上下文只查询当前工作区的 CodeGraph；增强只提供代码检索和最近一轮对话，不恢复旧 Wiki RPC。系统任务执行前必须找到当前登记的任务类型，避免启动恢复时对旧 Wiki 队列发模型请求。既有记录保留，未完成的旧任务走通用失败收尾。删除退役宿主解析器、已撤 IPC 的前端封装、孤立测试资产及未接入当前构建的一次性清理脚本。

[Repo Wiki 裁撤](../simplification/2026-11-08-retire-repo-wiki-and-knowledge-cards.md)仍约束数据保留；[最近一轮对话](../feature/2026-10-25-enhance-recent-turn.md)的快照与 [CodeGraph 独立宿主](../architecture/2026-10-16-codegraph-host-process.md)仍有效。保留 CLI 命令、旧数据读取与拒绝退役入口的测试。

## Alternatives considered

- 给旧 Wiki 查询加空结果回退：能避免界面报错，但模型仍会被引向不存在的能力，也会留下两个无效 RPC 调用。

## Consequences

面板可独立显示索引状态；增强不再向模型提供旧 Wiki 工具。保留旧历史解析和现行线程、索引、授权、审计、插件状态。未执行数据清理脚本。

## Verification

- 项目上下文和增强的定向 Vitest：41 项通过。另验证 CodeGraph 路由、打包断言、退役端点、CLI 外的工具提示元数据与 Fable 加载。
- 系统任务相关定向 Vitest：注册表、worker、短调用和门面 27 项通过；TaskQueue 13 项通过，含旧 queued/running Wiki 记录不调用执行器的用例。代码索引模块入口 1 项通过。
- `pnpm --dir electron-agent ui:check project-context code-retrieval-panel code-index-sync`：100 个断言通过。实看 `.agents/evidence/2026-11-13-retired-wiki-live-paths/project-context.png`。Electron 输出已有的资源包缺失警告，未阻断场景。
- 本机有与 TS 同名的旧编译 JS；涉及退役执行的五份旧产物移到系统临时目录备份。默认测试配置复验关键系统任务，不删除其他产物。
