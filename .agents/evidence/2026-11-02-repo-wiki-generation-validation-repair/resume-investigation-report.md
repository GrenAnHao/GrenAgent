# f2 恢复失败只读调查

## 结论

当前 `f2cca0ce-1ed0-4687-9f2f-c4b6b71a0f93` 为 blocked，11 prepared、1 failed、4 blocked、0 published。upstream 原失败候选在新修复载入**之前**已被旧执行覆盖；新进程恢复时其行已为 `MODEL_ERROR`、`payload=null`，不再满足 `readFailedCandidate` 要求的 `INVALID_*` 错误和有效 payload，因此无法进入自身候选本地复验。不能依据这次真实运行声称新分支已成功处理原候选，也不能将候选在新代码载入前被覆盖误判为新分支条件错误。

`live-second-failure.json` 于 17:15:27 保存了原始候选正文、Read evidence 和依赖；原始用户数据库行在 17:35:29.303 变为 upstream failed / attempt 2 / MODEL_ERROR / null。新构建 out 于 17:37:59 写入，新 AgentData host 于 17:38:30 启动。17:35 恢复的触发者没有可用证据；用户审计记录了 17:15:17 和 17:36:26 两次 pause，未记录 resume 来源，不推断。

只读重建冻结图（`resume-graph-investigation.json`）：此前保存的候选 inputHash 与当时节点/父任务相等；全部依赖为当前任务 prepared 且 hash 相等；来源证据经冻结 hash 匹配后，当前规范化、strict validation 和 graph advance 全部通过。先前 `navigation-real-preflight.json` 已验证候选原 payload hash。事务/fence 晋级在原行被覆盖后无法从当前数据库复现；当前错误和空 payload 会在此之前被拒。离线 fixture 中自身候选复验可在相同 attempt 下成功，但该 fixture 不是这次真实任务的实际晋级。

## 每项用量与时间（北京时间）

| 项目 | Attempt | model 请求 | tool 请求 | model token 记账 | 时段 |
|---|---:|---:|---:|---:|---|
| upstream | 1 | 20 | 56 | 229,940 | 17:11:32–17:14:52 |
| upstream | 2 | 0 | 0 | 0 | 17:35:29 失败 |
| CLI | 1 | 6 | 8 | 112,513 | 17:14:53–17:15:17，暂停 |
| CLI | 2 | 11 | 15 | 156,768 | 17:35:29–17:36:26，暂停 |

以上是 `knowledge_execution_requests` 实际 settled 账本，模型共 57 次。upstream 的 20 次已达该页 20 次上限；17:35 attempt 2 未登记任何模型请求。离线 `resume-budget-reproduction.json` 显示模型端 `BUDGET_EXHAUSTED` 经 Agent 的 stopReason error 可被转换为 `MODEL_ERROR`，与其 20/20 状况一致，但已丢失的原始异常不能由此证实。

CLI 的两个中断请求用量未知，分别按预约 56,768 和 67,792 token 结算，不应退还。累计 model 17/20、tool 23/60、token 269,281/300,000、active time 210,000/600,000 ms。17:40 恢复时 CLI 当前仍为 attempt 2，`beginAttempt` 计算 attempt 3 超过上限 2，抛 `BUDGET_EXHAUSTED`；异常落账把原 running attempt 2 变 blocked attempt 2，没有发出新的模型请求。

## 原预算内的可能性与限制

可检验的修复方向是使用保存的原 upstream 候选，在相同 task、原账本、冻结输入、依赖和 fence 下恢复并本地复验；这涉及真实数据恢复，必须先由根代理获得实际操作授权并审查，不能直接改用户数据库。

CLI 的 attempt 2 是控制暂停，不是已完成的业务失败；可研究按原 attempt 恢复，但当前 stage 不持久化中断 transcript，只能重新开始工具循环。剩余 3 次模型请求和 30,719 token；前两次首轮预约都为 34,393（按当时 8,192 输出额度推算输入约 26,201），当前代码会自适应缩小输出额度，若输入估算一致则首轮理论最多约 4,518 token。它未证明可完成；不能重置 attempt、退款未知用量、增加预算或实际请求模型来掩盖这个限制。

证据脚本只以 `readOnly:true` / SQLite `mode=ro` 读取用户数据库和冻结计划；`resume-budget-reproduction.mts` 是纯本地假模型抛错，不接网络。本轮未修改真实任务、数据库或项目文件，也未调用付费模型。
