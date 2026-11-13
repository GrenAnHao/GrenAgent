# Repo Wiki 真实模型生成验收（note-pocock-flow）

日期：2026-11-04
变更：`fix-repo-wiki-and-codegraph-sync`（任务 5.3 / 5.4 / 5.5）

## 结论

**通过。** 真实模型、真实子进程、真实 native SQLite、真实文件投影，一次跑到
`state=completed`，20/20 篇发布，`projection=ready`，页面正文与磁盘文件逐字相等。

## 装配

一次性 driver（`electron/app/tmp-realgen.mts`，验收后已删除）。结构照抄
`electron/app/repoWikiFlow.integration.test.ts` 的 in-proc 装配：真实 `RepoWikiService`、真实
`repo-wiki-host` 子进程、真实 `NativeWikiProjection` / `wiki.sqlite`、真实 `ProjectFiles`；
只把 fixture 模型换成真实 `KnowledgeModelPort`（`agentDataModel` = `custom-mvjk9w7k/deepseek-v4.1-flash`）。

项目 `D:\System Dir\Downloads\note-pocock-flow`，zh，commit `f61fd63` —— 与修复前失败任务
`4ba605e2` 同一仓库、同一提交。

## 最终结果

| 项 | 值 |
| --- | --- |
| 终态 | `completed` |
| publication | `5e0c18be`，published 20 / readable 20 / failed 0 / partial false |
| projection | `ready` |
| 磁盘 | 20 个 md，共 311,850 字节 |
| 模型请求 | 115 次，0 次错误 |
| token | input 792,279 / output 180,224 / total 1,953,751 |

## 请求分布

| 阶段 | 请求数 |
| --- | --- |
| overview | 11 |
| plan | 11 |
| catalogue-root | 5 |
| catalogue-child | 8 |
| page | 80（20 篇 × 4） |

## 速度修复的效果

本轮修了三处，全部有实测对照：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| page 每篇模型调用 | 10.37（实测 30 篇） | **4.00**（实测 20 篇，全部一致） |
| catalogue-root | 6–7 | 5 |
| 并发 | 1（driver 写死，我的失误） | 5（生产默认） |
| 单篇工具调用 | 约 20 次（35 次 Read 的一篇） | 4 轮封顶 |

改法：

1. `referenceProfiles.ts` 新增 `maxStepsByPurpose`。原来所有阶段共用 `maxSteps: 10`，而 page
   的提示词已经给了仓库树、README 和依赖文件；模型把 10 步当成预算，每篇跑满。
   现在 overview/plan 10、catalogue 4、page 3（+1 收尾轮 = 4 次调用）。
2. `sessionRuntime.ts` 对同一 session 内参数完全相同的 `Read`/`Glob`/`Grep`/`ListDir` 复用首次结果，
   不再发一轮往返。只作用于只读工具。
3. catalogue 的自我回显（`README > README > README > installation`）改为无损归一：
   `normalizeCatalogueTree()` 丢掉与父同名的包装节点、把孩子提上来。真实树 67 → 63 节点。
   这里刻意选择「归一」而不是「拒绝」——拒绝会让两次都回显的整次生成失败，是能力退步。

## 与修复前的对照

修复前（任务 `4ba605e2`，同仓库同提交）：

- 31 次模型请求，0 篇发布，`state=failed`
- 卡在 catalogue：`650dc081`（01-overview）两次尝试都失败
  - attempt 1：section prompt 内含 `--cmd "真实验收命令"`，内层引号未转义，`JSON.parse` 在 offset 4596 报错
  - attempt 2：合法 JSON，但为单个 section 对象而非数组
- 错误码 `CATALOGUE_CHILD_OUTPUT_INVALID`

本轮同一阶段：

- 解析容错让上述两种形状都能通过
- 瞬时错误重试让 `7b2329e5`（第一次「no valid JSON」）、`879ec17f`（第一次「section missing prompt」）、
  `762bab59`（第一次 `document_heading_missing`）都在第二次尝试上恢复
- catalogue 没有任何 child 两次都失败

## 未覆盖

- 桌面应用内实际点击（本轮走的是与服务相同的 IPC 命令面，不是 UI）
- `CATALOGUE_OUTPUT_*` 的中文文案
- 增量更新（`update` / `sync`）路径本轮未跑

## 复跑

driver 已删除，需要时按 `repoWikiFlow.integration.test.ts` 的装配重建，把 fixture 模型换成
`createAgentDataModelPort`。三个环境变量控制：`CONCURRENCY`（默认 5）、`MAX_REQUESTS`、`MAX_TOKENS`。

真实生成成本参考：本项目 20 节、115 次请求、约 195 万 token、约 10 分钟（并发 5）。
