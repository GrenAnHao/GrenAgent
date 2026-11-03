# KnowledgeKernel 定向复审

2026-11-01；独立复核先前四项修复，以及新增 Cards 存储映射、嵌套目录依赖、发布与索引恢复、currentItem/freshness 和控制请求幂等。未修改业务代码。

## 结论

先前四项原问题及本轮发现的相邻恢复调度问题均已解决。最终定向复核没有未解决的 P1/P2；没有发现新的 Cards 兼容或发布顺序 P1/P2。

### 已解决：[P2] LEASE_BUSY 重试丢失恢复模式

- 位置：`electron-agent/electron/agentData/knowledgeKernel/coordinator.ts:52` 的 LEASE_BUSY 分支；现已使用 `setTimeout(() => this.schedule(taskId, recovery), 1000)`。
- 触发：Wiki 已暂停且保留 pause control；同项目同语言 Cards 持有写租约；用户恢复 Wiki。首次恢复正确得到 LEASE_BUSY。Cards 随后释放租约，但定时重试没有沿用 recovery=true。
- 后果：第二次 run 在 claim 之前发现 pause control，按普通启动直接 return。任务永远留在 paused，用户已发出的恢复请求没有执行，也没有继续排队。自动恢复多个 application_exit 暂停任务也受影响。
- 最小修法：重试保留本次启动模式：`this.schedule(taskId, recovery)`。回归需覆盖“先 busy、后释放、没有再次点击恢复也能进入 prepare”。
- 实测：真实 AgentDataStorage/KnowledgeBuildStore/KnowledgeKernelCoordinator，内存 SQLite；仅项目 read/installFence/prepare 使用端口桩。Cards 释放后等待 1.2 秒输出 `{"state":"paused","claimCalls":1,"prepares":0,"control":"pause"}`。这证明第二次重试未再尝试 claim，而非仍然等待 Cards。
- 最终复核：已阅读新增 `retries a paused task after a sibling releases the same write lease` 回归；它使用真实 SQLite、WorkspaceEngine、KnowledgeProjectPort，暂停 Wiki、等待 Cards 取得租约、恢复 Wiki 并确认确实发生竞争，再取消 Cards，断言 Wiki 自动完成。C 报告该用例 RED/GREEN。
- 本代理独立复跑先前相同的定向复现，修复后输出 `{"claimCalls":2,"prepares":1,"error":"REACHED_PREPARE"}`。`REACHED_PREPARE` 是验证端口主动抛出的停止标记，证明未再次点击恢复即可重新 claim 并进入 prepare；这次断言通过。

## 四项修复复核

1. **同 epoch 活跃租约保护已修。** store.claim 先检查非零现有租约；同 controller epoch 即使传 previousExecutorExited 仍返回 LEASE_BUSY。只有不同 epoch 且有恢复证明允许接管。竞争后的重试现已保留恢复模式。
2. **旧收据与未开始的当前发布已区分。** ProjectPort.reconcile 先恢复 journal，再同时检查当前 guard 的 task/fence/claim 及历史收据 generation；当前 guard 未绑定或已绑定本次 claim、收据仍旧时可判 not_prepared。精确匹配的收据仍走 matching；不一致事实保留 conflict。
3. **搜索/目录观察已进入增量判断。** readTools 写实际目录范围，根范围用 `.`；coordinator 发布保存 scopes，并兼容从 evidence.path 提取；reusePublished 也比较观察范围内文件增删改。`scopeContains('.')` 覆盖全项目，原先同目录新增文件漏失效路径已关闭。
4. **显式排除旧文件已允许。** prepare 对缺失 baseline 路径先判断当前 include/exclude 及 ignore 规则；只有仍属于本轮扫描范围且存在但未扫描的文件才阻止生成。ignore 内容进入 scopeHash，使范围变更不能静默复用。

## 新增链路复核

- Cards 写盘使用 `cards/<logicalId>`；read 还原 logicalId/dependencies，既有页面 API 使用存储 ID。Wiki/Card 同名与嵌套相对链接的语义匹配；项目端口测试直接覆盖真实 engine.get_page，而非只断言字典。
- Wiki 目录子项在父路径下展开，组依赖最终展开为叶子依赖；生成节点和发布 definitions 使用解析后的叶子依赖，嵌套页进入既有页面存储路径。
- 正常发布和恢复均先取得/识别 receipt，再刷新索引，最后 settle；刷新失败保留 pin 和 INDEX_UPDATE_FAILED，重启恢复不用重调模型。未发现提前 completed 的路径。
- 暂停/取消请求持久化幂等记录，旧请求重发不会取消一次新的 resume；currentItem 仅作为任务投影元数据；freshness 的显式扫描结果与正式 baseline 比较，不将未扫描状态称为 current。
- 最后核对宿主 roots 条件：`hostRootsEnforced = options.allowedRoots !== undefined`，存储 token 必填与宿主目录授权独立；显式空 roots 仍受限。父任务报告对应 legacy token 与 empty/revoke deny 定向测试 9 PASS，本代理仅核对该条件，没有扩展重跑。

证据范围：本轮审阅实际源码及对应定向回归定义，并独立执行上述恢复竞争复现。父任务提供的六文件 41 PASS 和 A 的真实 SDK 双 child 流程由各执行者报告，本报告不把它们写成本代理亲自运行结果。未重跑无关仓库测试或 UI 场景。
