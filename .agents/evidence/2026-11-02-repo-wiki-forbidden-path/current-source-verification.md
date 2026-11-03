# 当前源码生产链路验证

时间：2026-11-02 14:14–14:15（Asia/Shanghai）

## 结果

- 当前源码的 KnowledgeKernel 集成 3 项和宿主 workflow 集成 1 项通过，退出码 0；共 2 文件 4 项，58.40 秒。
- `npm run build` 通过，退出码 0；包含主工程与 Repo Wiki 类型检查，以及生产主进程、preload、renderer 构建。产物写入 `electron-agent/out-pkg/`。
- 本验证未修改实现源码、未启用真实付费模型、未重启应用、未运行 localrun，也未跑全仓或无关 UI。

## 命令与证据

工作目录：`D:\OneDrive\Project Files\Pi\electron-agent`。

```powershell
$env:REPO_WIKI_REAL_E2E=$null
npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts electron/app/repoWikiWorkflow.integration.test.ts
npm run build
```

- `current-source-integration.log`：完整测试命令输出与退出码。
- `current-source-production-build.log`：完整生产构建输出与退出码。
- `knowledge-kernel-integration-66332-resume-incremental.json`：真实 AgentData / Repo Wiki 两个 OS 子进程，官方 Pi Agent 工具循环，loopback HTTP，ACK 恢复与 dirty 模块增量。
- `knowledge-kernel-integration-66332-partial-repair-controls.json`：部分失败、定向修复、旧正式正文保持、暂停和取消的实际 HTTP abort。
- `knowledge-kernel-integration-66332-cards.json`：模块卡、仓库卡与关系发布。
- `workflow-integration-report.md` / `workflow-integration.log`：真实宿主项目列表、双进程、官方 SDK、共享知识模型并发、取消、项目上下文与模型身份兼容链路。

Kernel 场景具有实际发布验收，而非只等任务 completed：Wiki 断言正式发布计数为 2、`api.md` / `library.md` 文件存在和读取到正文；Cards 断言发布计数为 3、正式 ID 为 `cards/api` / `cards/library` / `cards/repository`、实际正文包含 `Verified api.ts`。loopback 返回来源路径、manifest hash 与行号，通过真实工具与发布链路处理。

构建产物包括 `D:\OneDrive\Project Files\Pi\electron-agent\out-pkg\main\repo-wiki-host.cjs`（867451 字节，14:14:44）。构建存在 SDK loader 的 CJS `import.meta` 警告和前端 ineffective dynamic import 警告，均未使构建失败。

## 真实模型 e2e 的断言缺口

`electron-agent/electron/app/repoWikiRealModel.e2e.test.ts`：

- 第 115 行只将 `docs/repo-wiki` 递归目录列表记入 `report.published`，并在读取失败时返回空数组。
- 第 116 行唯一结果断言是 `job.state === 'completed'`。
- 没有断言实际 Markdown 数量、预期页面集合、正文可读性或来源有效性。

该 e2e 本次仅检查源码，没有启用或调用。应由真实运行的验收者检查报告中的实际 Markdown 文件、数量与来源，不能仅凭该测试绿灯判定产物完整。

## 对本次故障结论的边界

本组集成证明当前源码可以经真实生产桥与官方 SDK 完成生成发布、恢复、增量和失败修复。loopback 场景未主动注入用户同款 `overview FORBIDDEN_PATH`；该错误的恢复专项由父任务已运行的 `readTools.test.ts` 与 `stageRuntime.integration.test.ts` 覆盖。本记录不将两类证据混同为一次真实模型重现。

验证期间 `out/` 在 14:15 被父任务按用户新授权备份并重新构建；该运行产物更新不由本验证执行，不影响本组 temp-build 集成与 `out-pkg/` 构建证据。
