# sa-1d7293f9：最终回复完成与会话中止结算的区别

核对结果：不是把 completed 误映射为 aborted；该条父会话原始结算就是 aborted，但子会话更早已经正常写出最终回复。

| 记录 | 本地时间（UTC+8） | 原始事实 |
| --- | --- | --- |
| 子会话 JSONL 第 283 行 | 2026-10-28 15:50:40.068 | assistant.stopReason = stop，text 正文 1267 字符，开头为“审查完成，只读…” |
| 子会话 JSONL 第 284 行 | 2026-10-28 15:55:40.627 | subagent_meta.tornDown = true |
| 父会话 JSONL 第 580 行 | 2026-10-28 15:55:51.767（落盘） | customType = subagent-settled，details.childId = sa-1d7293f9，details.stopReason = aborted，摘要为“was stopped before it finished” |

子会话文件：`C:/Users/rxstudio/.pi/agent/sessions/--D--OneDrive-Project Files-Pi--/2026-10-28T06-55-07-351Z_sa-1d7293f9.jsonl`。
父会话文件：`C:/Users/rxstudio/.pi/agent/sessions/--D--OneDrive-Project Files-Pi--/2026-10-28T05-28-36-575Z_01a180fb-51df-7286-9055-c369174ce410.jsonl`。

`settlement-sa-1d7293f9.txt` 是只读扫描得到的元数据摘录，`inspect-settlement.mjs` 可复查。没有改写用户会话文件。

当前判定优先级：已有 details.stopReason；缺失时才识别官方通知摘要。不会根据回复中“审查完成”等自然语言把终态改为 completed。

源码 `extensions/multi-agent/activation.ts` 的 disposeActivation(reason='cancel') 路径会保留最后回复并发送 stopReason='aborted'；这与记录一致。原通知没有保留释放发起者或更具体原因，不能据此认定用户主动取消，也不能仅凭约 5 分钟的间隔认定超时。本文不把“助手正常结束一条回复”擅自等同“整个任务生命周期正常结算”。

展示修正：aborted 标题写“会话已中止”，正文分节写“已保留的回复”，区分会话生命周期与任务结论；原始 aborted、调度与运行逻辑保持不变。没有足够证据时不宣称任务已完成或失败。

未重启 dev 不妨碍前端热更新加载新卡片；它不会改变后台已经生成和落盘的状态值。重启也不会把历史 aborted 自动改为 completed。
