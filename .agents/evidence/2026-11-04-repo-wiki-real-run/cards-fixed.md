# 知识卡：从 0 篇到 10/10 发布

日期：2026-11-04
变更：`harden-knowledge-card-json`

## 结果

**`state=completed`，10/10 张卡片发布，14 项全部 prepared，0 失败 0 阻塞。**

```
counts   {"planned":10,"prepared":10,"failed":0,"blocked":0,"published":10}
items    14 {"prepared":14}
cards published 10
requests 141
```

发布的卡片：

```
cards/architecture  cards/getting-started  cards/modules/bin   cards/modules/examples
cards/modules/notes cards/modules/pocock   cards/modules/scripts  cards/modules/templates
cards/overview      cards/repository
```

## 基线对照

| | 修复前 | 现在 |
| --- | --- | --- |
| 终态 | `failed` | **`completed`** |
| 发布 | 0 篇 | **10 篇** |
| 失败项 | 1 failed + 1 blocked | **0** |
| 模型请求 | 17 | 141（多了，因为卡片真正写完了） |
| 每轮工具数 | 1.00 | **1.97** |
| 轮次分布 | 单卡 20 轮耗尽 | 8–19 轮，中位 13 |

## 修了什么（按发现顺序）

| # | 缺陷 | 证据 |
| --- | --- | --- |
| 1 | `parseStageJson` 把正文里的 ``` 当成 JSON 外层围栏 | 候选顺序改为外层对象优先，只信任末尾围栏 |
| 2 | 格式失败一律不可重试，`maxAttempts` 形同虚设 | 实质回答（≥256 字节）标 `retriable: true` |
| 3 | 轮次耗尽后连一次纠正机会都没有 | 新增一次不计入轮次的纠正请求 |
| 4 | `repository` 不是 relations 的合法端点 | 真实报错 `INVALID_RELATION`；已加入 `graph.definitions` |
| 5 | `source:../bin/npf` 被判非法 | 新增 `source-parent` 类型，由调用方判定 |
| 6 | `module-card` 20 轮、`repository-card` 12 轮预算过小 | 提到 28 / 24，活跃时间 10→20 分钟 |
| 7 | **56% 的轮次只发起一次读取** | 每轮声明剩余读取额度与本轮建议并发数；系统提示把「一次读完」写成硬要求 |
| 8 | 供应商 120 秒超时被判永久失败 | `aborted` 与 timeout 类错误标 `retriable: true` |

第 7 条是关键：提示词原来只是「请批量」，模型不照做。改成**把剩余额度直接报给模型**（「你还有 10 次读取，分布在 3 轮里，这一轮请一次要 4 个」）后，平均每轮工具数从 1.00 升到 1.97，请求数从 198 降到 115（同样工作量），修复轮次撞墙才可能。

第 8 条是这次跑出来的新问题：两轮真实运行里 `card:architecture` 和 `card:modules/pocock` 都卡在 120 秒 `Request aborted`，而超时被当成永久失败，一个已经读完大半资料的 stage 就这么丢了。

## 可观测性

新增 `StageExecutionResult.diagnostics`：

- `turns`: 每轮的输出 token 数与工具调用数
- `rejectedAnswer`: 解析失败时的模型原文（截断 32 KiB）

落在 `knowledge_build_items.diagnostics` 列，`store.readDiagnostics()` 可读。这次就是靠它直接看出「每轮只读一个文件」，不必再靠六轮复现猜。

## 仍未做的

- `RePo Wiki`（不走知识卡的那条）与知识卡共用 `StageExecutionResult` 契约，但 Repo Wiki 的 native 路径不受影响 —— 本轮 243 → 244 项测试全绿，Repo Wiki 84 项也保持通过。
- 桌面 UI 内实际点击仍未做（本轮走的是与服务相同的 IPC 命令面）。
