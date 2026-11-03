# KnowledgeKernel 规划审阅记录

日期：2026-11-01。范围：设计规格、12 项实现计划及 proposed 决策笔记。仅规划层审阅，未运行实现测试。

## 代码与 SDK 核对

- 已核对实际 Pi SDK 1.3.0 的 Agent、StreamFn、TranscriptContext、ModelRuntime.streamSimple 与 AssistantMessageEventStream 声明；没有按旧版本注释或把字符串 completion 当成 tool-loop。
- 存储审阅确认实际文件冲突域是项目/语言，覆盖 Wiki、Cards 和多个 namespace；已将 lease/fence/publish pin 作用域写入规格。
- 保留项目文件事实源、现有 token/journal、AgentData 单 DB owner、旧资料 Wiki/CodeGraph 与 Memory 裁撤边界。

## 独立审阅与修订

1. **条目未 ACK 时预算丢失**：原稿只写预算随检查点持久化，无法约束单元中途崩溃。已改为 beginAttempt + model/tool/time reservation 独立落账、先预扣后执行、未知结果不归零，并列出对应强杀验收。
2. **epoch drain 与计量 ACK 依赖环**：原稿可能等待已死亡 controller 的 DB ACK。已明确 provider/worker drain、无派发新账本 reconciliation、activateEpoch 三步，正常 ackUsage 不参与 provider-settled Promise。

审阅者复核以上修订后，在规划层面未发现剩余阻断项。补充约束：provider 的首个时间片必须在获得槽位后、发送 HTTP 前预扣；已同步规格与任务 3。

## 自检

- 规格章节 1–13 均映射到实现任务 1–12，映射保存在 planning-check.json。
- 已核对完整契约命名、local Markdown links、任务顺序与审查风险对应验收。
- 阶段成果、source manifest 和传输帧的大小限制分开定义；预算默认值接受任务时冻结。
- 本轮只新增规划/证据文档，未把旧 implemented 决策伪装为已经被新内核取代。

实际校验输出见 planning-check.json 与 verify-notes.log；其中的通过仅指文档/规划门禁，不证明未来内核功能已经运行。
