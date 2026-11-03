# Qoder Repo Wiki 静态证据备忘录

核验日期：2026-11-02。供“对齐 Qoder”的提案与实施计划引用。

## 对齐方向

Qoder 在生成正文前收齐最终目录。目录阶段先生成根结构，再按节点有界并发展开并保存检查点；正文阶段也有独立并发调度。这里的“整套目录”指进入正文阶段前的完整成果，不代表固定一次模型调用。

Pi 可借鉴阶段边界、目录与页面的有界并发、检查点及发布前清单校验，同时保留已确认的“必需页齐全、整批原子发布”。Qoder 的 completion manifest 允许部分页面失败后发布，二者的成功条件不同。

## 可核对的本地材料

既有调查对象为本机 Qoder 0.5.1 stable、知识中心插件 0.1.1、context 插件 1.0.91.b22f2d0a（revision 2026102902）。本次复用已有文本提取产物，未重新解包。

- 安装位置：`E:\Qoder\resources`。
- 原调查报告：`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\REPORT.md`。
- 可读核心副本，下文简称 **engine**：`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\engine\qoder-search.pretty.mjs`。
- 原 bundle：`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\native\context-plugin\qoder-context-plugin\runtime\qoder-search.bundle.mjs`。
- 既有符号与原始字节区间映射：`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\engine\symbol-index.json`。
- Node/daemon 边界：`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\native\native-report.md`、同目录 `native-evidence.json`。
- UI 调查：`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\ui\ui-findings.md`、同目录 `view-excerpts.txt` 和 `source-index.json`。
- 既有可携带摘要：`D:\OneDrive\Project Files\Pi\.agents\evidence\2026-11-01-repo-wiki-knowledge-kernel-design\qoder-reference.md`。

`.tmp-qoder-analysis/` 是本机已有的忽略目录。以下记录包含关键符号、行号和观察结果，读者无需依赖 E 盘才能理解本提案的依据；核对原文时需要上述提取产物。

## 观察：静态源码能够证明什么

### 独立 context 承载生成

`D:\OneDrive\Project Files\Pi\.tmp-qoder-analysis\native\context-plugin\qoder-context-plugin\mcp.json` 的 `qoder-context` 项将命令设为 `${QODER_NODE_RUNTIME}`，参数为 `runtime/qoder-search.bundle.mjs mcp-bridge`，`startup` 为 `application`。

`native-report.md` 的“确认的调用边界”和“确认的进程生命周期与恢复边界”记录：知识中心 Node 插件通过本地 socket JSON-RPC 调用 daemon，bridge 再启动 `daemon-server`；生成入口不走普通聊天 `createSession`。context 插件的 `runtime/runtime-manifest.json` 指定 Electron-as-Node 与同一 bundle 入口。

### 全量阶段在正文前完成目录

engine `Kkt:93181–93242` 先执行 `Okt(e, [jUn, LUn, UUn])`，再完成 catalogue，随后调用 `VUn` 生成 page，最后产出 `completion_manifest`。`jUn/LUn/UUn:93258–93338` 对应 readme、overview、plan；readme 归一化输入，overview 和 plan 发起工具会话。

`tSt:94562–94602` 消费阶段事件，要求引擎给出 completion manifest，再调用 `g.publish(...)`。可将全量概括为 readme → overview → plan → catalogue → page → 发布前验证 → publish。作者已明确给出页面时，overview/plan 可跳过。

### 目录按节点展开，并非固定单次调用

engine `FUn:93342–93395`：

1. 无恢复成果时先调用 `Ukt(e, null)` 生成根结构，保存 `seq/tree/expanded` 检查点。
2. `ZUn` 找出待展开节点，挑选当前最浅层。
3. 通过 `Ud(..., e.config.full.catalogue.execution.concurrency, ...)` 对这些节点分别执行 `Ukt(e, node)`。
4. 每个成功结果更新子节点、expanded 集合和序号，并保存检查点；循环至没有待展开节点。

`Ukt:92981–93038` 根据是否传入父节点构造根目录或子目录请求；`ZUn:93040–93052` 负责枚举待展开节点。初始根结构若已满足条件，可以直接结束；代码不保证每次都发生多次展开。

### 页面并发由内核实现

engine `VUn:93109–93125` 使用：

```js
Ud(items, e.config.full.page.execution.concurrency, ...)
```

`Ud:55341–55415` 将任务放入 Promise 池，启动数量受 concurrency 限制，用 `Promise.race` 收取完成结果并补入后续任务。因此页面并发有调度器证据，不依赖 UI “处理中 N 篇”的文案推断。

`nf:55476–55488` 中的内置默认值：release 的 catalogue/page/pageUpdate/pageAdd 均为 **3**；debug 均为 **6**。`uM:90007–90022` 将 release 默认值接入目录和页面配置；配置可覆盖。**这些值不是用户机器实际有效并发的测量结果。**

UI `view-excerpts.txt` 原始行号 42339–42368 的 `RepoWikiStatusCard` 读取 `processingPageCount`；该字段只能证明 UI 展示处理数量，不能独立证明后台并发。

### 各阶段拥有独立预算配置

engine `eTe:89949–89967` 按 `wiki.full.overview`、`wiki.full.catalogue-plan`、`wiki.full.catalogue`、`wiki.full.page` 及增量 purpose 映射 session profile；`uM:89994–90049` 分别定义 session、重试、并发和内容验证参数。

`_n:55440–55468` 的内置 Wiki 默认值为：每 session 的 `maxInputTokens=150000`、`maxOutputTokens=16000`，各 purpose `maxSteps=10`，执行 `maxAttempts=2`，目录最大深度 4。不同阶段可以独立配置，但这些默认 session 数值相同，不能据此声称默认额度按阶段分出了不同大小。

2026-11-02 再核原始字段：`eTe:89949–89967` 将 `maxInputTokens` 映射到 `profile.contextWindow`，不是多次 HTTP 累计计费输入上限。`R5:119217–119226,119386,119430,119468–119476` 用初始提示/工具 schema、assistant 消息和工具输出的估算量维护上下文护栏，到界限时强制收尾；不是精确 tokenizer，也不是累计 usage 账本。`PCt:118611–118626` 将输出值写入模型偏好 `maxTokens`。`executeSession:119148,119230–119233` 将 `maxTurns` 设为 `maxSteps + 1` 后调用 SDK query，为收尾留一回合；step、SDK turn 和供应商 HTTP 请求数不能直接等同。`bf:92475–92482` 的两次 attempts 包括首轮，仅可重试执行/校验失败继续下一次，不可重试错误直接终止。

`R5.executeSession:119086–119168` 将 profile 转为 SDK 的 maxTurns、context-window、模型、允许工具和严格 MCP 配置；`119230–119233` 调用 SDK query。

### completion manifest 控制发布，但允许部分发布

engine `Kkt:93215–93241` 构造必需阶段和页面清单。其中 page checkpoint 的 `allowedDispositions` 为 `done/failed`，`requiredPageIds` 只含已成功集合。

`verifyCompletionItems:35987–35994` 检查必需 checkpoint 与 disposition；`publishRun:35995–36008` 在事务内先验证 manifest，再切换 published snapshot、baseline 和完成状态。Wiki `verifyDomainManifest:36519–36525` 检查 section 存在及必需正文非空。

因此，Qoder 的“manifest 校验成功”不等于“所有计划页面都成功”。Pi 保留“必需页齐全才整批原子发布”，属于明确保留的项目契约差异。

这里已确认的是阶段结果验证与发布前 manifest 校验，未见单独的 `wiki.full.validation` AI purpose；不应写成固定存在一次独立模型验收。

### Git baseline 与差异驱动增量

engine `l4n:94390–94435` 使用 baseline commit 和 target commit，调用 `inspectDeltaGate`、`prepareDelta` 或 `inspectDelta` 形成决策与 delta；无索引文件变化时可选择 advance。

`89963–89966` 定义 commit-analysis、catalogue-analysis、page-update、page-add purpose；`94014` 按 update/add 两组分别有界并发处理页面。该链路超过单纯按文件时间或页面指纹重跑的能力范围。

## 推论与本项目选择

- 建议把 catalogue 保持为一个可恢复业务阶段，在阶段内按节点有界并发、逐结果保存检查点；最终目录冻结后再派发页面。不要把“对齐整套目录”实现成单次大模型请求的硬性要求。
- 页面并发应与共享模型全局并发门分别建模；本次证据证明 Qoder 具备页面调度池，不证明 Pi 适合照搬 3 或 6。
- 保留 Pi 的 AgentData 唯一任务体系、项目 Markdown 事实源、启动自动继续和整批原子发布；这些是项目已确认的契约。

## 证据范围

本次仅阅读已有报告、格式化副本和提取文本，未运行或修改 Qoder、未调用真实模型、未下载或重新解包安装包。静态控制流可以证明能力与默认配置，不能证明实际有效并发、动态性能、生成质量、成本、故障恢复效果或稳定性。上述提案应以 Pi 自己的实现和定向动态验收建立这些结论。
