# 双域命名与阶段执行：实现与验证记录

日期：2026-11-05
变更：`sync-wiki-and-cards-generation`

## 结论

五项改动全部落地并验证。核心结果：**导出产物从 UUID 文件名变成可浏览的中文目录树**，且**撞到步数上限的阶段不再直接失败**。

## 一、并行工具执行

`electron/knowledgeProcess/stageRuntime.ts:176` 由 `toolExecution: 'sequential'` 改为 `'parallel'`。SDK 的 `ToolExecutionMode` 默认就是 `parallel`，是我们显式覆盖成了串行。

验证：新增用例让模型一个回复请求 4 个 `Read`，断言 `turnShape[0].toolCalls === 4` 且整个阶段只消耗 2 次模型请求（1 次读 + 1 次答）。

参照依据：Qoder 实测每步 2.9–4.5 个工具调用（`diagnostics/runs/wiki/.../0012-wiki.full.page`：step 1 一次发 4 个 `Read`）。

## 二、预算耗尽的收尾回合

达到步数上限时追加一次 `closing` 请求，`modelTurns` 不计入，但用量照常结算。

贯穿四处：
- `shared/knowledgeKernelContracts.ts`：`KnowledgeMessageInput.closing?: boolean`
- `electron/agentData/knowledgeKernel/store.ts`：`reserveExecutionBudget` 对 `closing` 豁免 `modelRequests`/`toolCalls` 两条上限，**token 与字节仍受约束**
- `electron/agentData/knowledgeKernel/modelRequests.ts`：把 `closing` 透传到预留
- `stageRuntime.ts`：`prepareNextTurnWithContext` 在 `turnsLeft <= 1` 时设 `closing = true`

验证：用例设 `maxModelRequests: 2`，模型从不主动停止，断言收尾请求恰有一次、带 `closing` 标记、阶段以 `prepared` 结束。

**过程中踩到的坑**：最初把提示词改成「Your step budget is spent」，破坏了既有测试依赖的 `'This is your final turn'` 字面量，导致 `prepareNextTurnWithContext` 每次重建收尾状态、无限循环、堆溢出。已恢复原文案。

## 三、不适用结果

`not_applicable` 作为第四种 disposition 贯穿：契约、zod schema、`store.commitItem` 计数、`coordinator` 的 settled 判定、`completionManifest`。

模型返回 `{"applicable": false, "reason": "..."}` 时转成该状态；`reason` 为空则 `NOT_APPLICABLE_REASON_REQUIRED` 失败（防止模型用它逃避工作）。

验证：两个用例，一个证明带理由的判定被接受且不计入失败数，一个证明无理由被拒。

## 四、展示名与 slug 双轨

核查发现 **native 路径本来就用中文名**（`electron/wikiService/projectAdapter.ts:83`：`title: section?.sectionName ?? section?.title ?? ...`）。截图里那个 `workflow-phases` 层层自我回显是旧内核的产物，不是本次改动范围。

因此第 4 组无需改动，只补了验证。

## 五、按展示名导出

`vendor/repo-wiki/packages/core/src/project-files.ts` 新增 `displayFileSegment()`：保留中文，只替换 `<>:"/\|?*` 与控制字符、去尾部空格与点、避开 Windows 保留名（`con`/`prn`/`aux`/`nul`/`com1-9`/`lpt1-9`）。

`engine.ts` 的 `export_markdown` 改为：
- 每个路径段（含父目录）优先用展示名，无对应页面的父目录保留 id 段
- 同级重名追加序号，不静默覆盖
- manifest 每条记录 `id`，导入靠它定位

`import_markdown` 相应改为按 manifest 的 `id` 解析，无 manifest 时回退到文件名并做大小写不敏感匹配。

### 实际导出形态

输入（`wiki_plan.json`，id 为 slug、title 为中文）：

| id | title |
|---|---|
| `getting-started` | 快速开始 |
| `architecture` | 系统架构 |
| `modules/cli` | CLI 主模块 (npf-cli.ts) |
| `admin` | 后台管理控制台 |
| `admin/overview` | 应用架构与入口 |

导出结果：

```
快速开始.md
系统架构.md
modules/CLI 主模块 (npf-cli.ts).md
后台管理控制台.md
后台管理控制台/应用架构与入口.md
```

`modules` 保留 id 段，因为它没有对应页面、拿不到展示名；`后台管理控制台` 有自己的页面，于是成为中文目录名。这与参照版本一致。

## 验证结果

| 套件 | 结果 |
|---|---|
| `vendor/repo-wiki` core 全量 | **167 项通过**（新增 `exportLayout.test.ts` 4 项） |
| 知识内核（`knowledgeProcess` + `knowledgeKernel`） | **248 项通过** |
| `npm run test:repo-wiki-flow`（真实 OS 子进程） | **9 文件 51 项通过** |
| `tsc -p tsconfig.json` | 0 |
| `tsc -p tsconfig.repo-wiki.json` | 0 |
| `openspec validate --strict` | 通过 |

## 修改的既有测试

三处硬编码文件名随导出契约变更调整，语义未放宽：

- `engine.test.ts`：`exported["a.md"]` → `["A.md"]`（title 是 `"A"`）
- `project-files.test.ts`：`["overview.md"]` → `["Overview.md"]`
- `cards.test.ts`：`["cards/persistence.md"]` → 改为动态解析实际导出的 key

## 未做的

- **真实项目上执行导出。** 没有对 `note-pocock-flow` 或任何真实项目跑导出。磁盘布局变化尚未在真实数据上验证。
- **界面验收。** 未启动桌面应用，UI 层如何呈现新的目录树未验证。
- **真实模型验收。** 全部用固定 provider，未调用真实供应商。
- **双域同批调度。** 知识卡与 Wiki 共享 partition 的架构改动不在本变更内。
