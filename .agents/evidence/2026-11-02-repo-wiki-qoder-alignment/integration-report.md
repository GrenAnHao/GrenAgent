# 任务 7：双进程集成验收

状态：9 个定向 loopback 用例均有有效 GREEN；真实模型 e2e 保持 skipped。未重启用户实例，未提交、推送或发布。

## 结果

| 验收 | 实际证据 |
| --- | --- |
| 6 独立页及依赖链 | `a/b/c/e/f/g`，`a → z-after-a → z-after-chain`；最终正式页集合准确等于全部 8 个必需页 |
| 有界并行 | page/catalogue stage 峰值均为 3；global=2 时 HTTP 峰值恰 2，global=1 时峰值 1 |
| 空槽补位与逆序 ACK | A 持久化 ACK 后 E 开始，B/C 仍在途；C 在 B 之前 ACK；依赖 stage 的开始时间不早于父项持久化 ACK |
| 目录完整屏障 | 独立目录层 3 个真实 `catalogue:item:<logicalId>` stage 重叠；`catalogue:complete` 本地 ACK 后才开始正文，该节点无 HTTP 调用 |
| 取消与 drain | global=1/2 分别实际 abort 1/2 个 HTTP，全部 3 个 stage 结束；取消终态后不再派发、不发布 |
| 强杀与恢复 | 测试 AgentData OS child 被 SIGKILL，旧 epoch 两个 HTTP drain，新 OS child 自动续跑相同 taskId；已 ACK 的 A 不重发，正式 8 页齐全 |
| 冻结 v1 | 从测试 DB seed 的旧任务启动后继续，executionPolicy 仍缺省，预算/旧 pipeline hash 原样保留，stage 峰值 1，无 readme 阶段 |
| 部分失败与 repair | 正式两页在部分失败时保持可读；repair 使用新 taskId 且只重做 library；人工追加的 Markdown 注释在修复后仍保留 |
| 增量既有契约 | 脏 `lib.ts` 只重做 library，不重做 api |
| 正式内容 | 读取正式 receipt、namespace、全部 Markdown、冻结 required 图与 v2 completion manifest；页集合/计数一致，正文非空，来源 path/hash/行范围在冻结 snapshot 内；读取失败直接失败 |

正式内容验收 helper 另在实际成功产物上验证：清空正文会报错，删除文件会报错，之后恢复测试文件。不是仅凭 task.completed 判定。

完整 stage start/end、HTTP 时间与峰值、持久化 ACK 次序在 `integration-<场景>.json`；汇总见 `integration-summary.json`。所有仓库/模型配置/数据库/子进程属于本次 temp fixture，HTTP 仅访问本地 loopback，官方 SDK 与两个 OS child 使用生产链路。

## 命令与 RED/GREEN

以下命令均在 `electron-agent` 执行，先显式清除 `$env:REPO_WIKI_REAL_E2E=$null`。

1. RED：`npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'v2 keeps'`。旧实现新任务 executionPolicy.version 为 undefined，预期 2。见 `integration-red.log`。
2. v2 补槽专项 GREEN：同一命令。1 passed / 8 skipped，18.41 秒。见 `integration-green-refill.log`。
3. 关联用例：`npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts electron/app/repoWikiRealModel.e2e.test.ts`。7 passed / 2 failed / 1 paid-model test skipped。两项失败及修复如下；7 项未受后续增量专用修复影响，复用该次有效结果，不重跑无关矩阵。见 `integration-green.log`。
4. 修复后 GREEN：`npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'strongly killed|dirty module'`。2 passed / 7 skipped，无 unhandled errors，37.43 秒。见 `integration-green-recovery-incremental.log`。
5. 最终目录 ID 修复后 GREEN：`npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'independent catalogue|dirty module'`。2 passed / 7 skipped，无 unhandled errors，30.81 秒。仅重跑直接受内部 ID 变化影响的目录屏障及原有增量场景，其余有效证据复用。见 `integration-green-catalogue-item-ids.log`。对应两份场景 JSON 已刷新。
6. 真实模型 opt-out：`npx vitest run electron/app/repoWikiRealModel.e2e.test.ts`，1 测试 skipped；组合运行再次保持 skipped。没有付费模型调用。

## 集成发现与归属

- 产品：`project.readReadme` 遗漏内部 client 白名单，prepare 后报 `UNKNOWN_KNOWLEDGE_METHOD`；核心 owner 已修复。
- 产品：vendor process client 仍以 taskId 单槽登记，目录三路时第二/第三项报 `INVALID_KNOWLEDGE_SCOPE`；核心 owner 已改完整执行元组并补真实子进程测试。
- 产品：baseline JSON 属性排序使语义相同 catalogue:complete 的 hash 不同，增量错误重做 api；核心 owner 已修复语义映射并补定向回归，双 child 增量已通过。
- 产品最终命名修复：v2 合法逻辑 ID `root` / `complete` 与控制节点重名，核心将逻辑展开节点统一改为 `catalogue:item:<logicalId>`，保留 `catalogue:root` / `catalogue:complete` 和 v1 命名。fixture 现在记录完整 stageItemId，以完整控制节点身份生成 root 响应，以逻辑节点前缀控制目录 hold / 断言；两个直接受影响场景均通过。
- 测试 fixture：强杀前原 hold 顺序把 B/C 占满 HTTP 槽，A final 无法发送；改为显式放行 A/C 的首轮和 A final，先获得真实 ACK 再强杀。
- 测试 fixture：intentional kill 后反向 reply 的 IPC send 产生未处理 EPIPE；`repoWikiWorkflow.integration.fixture.ts` 为 send 增加 callback，把错误交回 RpcPeer.close。此前红灯保留在 `integration-green-recovery.log`（1 个 assertion pass，但 2 个 unhandled errors，不能作为 GREEN）；最终运行无此错误。

## 修改路径

- `electron-agent/electron/app/repoWikiKnowledgeKernel.integration.test.ts`
- `electron-agent/electron/app/repoWikiKnowledgeKernel.integration.fixture.ts`
- `electron-agent/electron/app/repoWikiRealModel.e2e.test.ts`
- `electron-agent/electron/app/repoWikiWorkflow.integration.fixture.ts`（仅测试 IPC send callback）

没有修改核心、shared、worker、RepoWikiService 或 UI 实现。

## 接口与后续验收

- 消费核心的 v2 `catalogue:item:<logicalId>` 与独立 root/complete 控制节点、children/expand、`catalogue:complete`、冻结 executionPolicy、baseline.graph 与 validate checkpoint 的 completion manifest.required。旧 `buildWikiStageGraph(input)` 仍为 v1。
- 根代理负责最终严格类型检查、构建、笔记门禁及本需求 UI 场景；本任务不重复这些共享检查。
- 当前用户实例加载版本和真实 UI/真实模型生成尚未验证。真实模型费用与重启用户实例均需用户另行授权；不能把本地 loopback 的通过当作这些操作的验收。
