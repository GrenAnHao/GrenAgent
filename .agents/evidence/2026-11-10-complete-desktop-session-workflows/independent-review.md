# A/B/C 独立审查与处置

审查者：`/root/review_desktop_sdk_features`，未参与设计/实现，只读。候选为当前未提交A/B/C源，HEAD e10f7afa239ef214d1150b8f542af4197f8c6efc；未把仓库既有492项dirty当本次diff。无Critical；A/B风险抽查可接受，C修复后复验。

## 已证实并要求原owner修复
1. Important — sessionWorkflowData.ts:50–54：strictSessionJsonl接受assistant.content字符串及缺必需字段。真实SDK transformMessages立即.flatMap异常。需role-specific内容和必需协议字段校验，激活前行/entry错误。
2. Important — sessionWorkflowData.ts:146–150 / PiRuntimeService get_messages：native context_edit:null使workflowHistoryMessages丢原文。实际SDKinMemory复现history=[]，branch原文仍在。需当前branch原始消息作历史基准、projection仅附effective状态，不改SDK请求上下文。
3. Minor但原规格验收项 — fork/clone直接执行，无保留路径预览；需要preview/confirm/cancel。
4. Minor但原规格验收项 — 导航草稿固定keep，空草稿也不自动填较早user原文；需按真实草稿状态默认，不丢已有草稿。

root决定：四项都按原规格修复，不以设计降级消除findings。C唯一owner负责源红绿、相关真实UI及最终生产候选；待owner交付后同一审查者仅核变化的修复。

## 抽查与范围外
A显式quota来源/最终fetch解压字节/unsupported拒绝/预算clear基线/settings写锁；B每调用scope/采集白名单/冻结与remote清除/registry原路径/外部history/legacy roster；C候选发布/文件授权/严格解析/历史投影/UI。
D尚施工，不属于该审查；历史类型诊断、升级前inline logout回退、用户已批准CLI延迟与SDK缺回调/辅助usage覆盖限制维持原边界。未全量重跑测试/UI、未启动正式app、无真实网络模型或凭据。

## 修复复核

同一独立审查者在C实际修补后仅复核原四项，全部解决，无这些修复引入的新回归。重新执行零网络inline tsx最小反例：非法assistant字符串及五项必需字段缺失均在第2行拒绝；native omit原文仍显示、contextOmitted=true/inContext=false；压缩窗口外原文保留，读history不改SDK有效上下文/raw entries。源码核到fork/clone preview→confirm/cancel绑定原target快照，空草稿replace、有内容明确选择；ChatView ownerKey→Launcher→真实ChatInput readComposerSnapshot包含附件/粘贴块链完整。未重复harness、冷registry生产脚本或A/B审查；C最终生产验收仍由root/C收口。

最后两项同契约增量也由同一审查者核完：所有preview不触发onApplied，mutation whitelist后经共享helper仅写目标owner草稿与匹配live editor；isIdle===false或workflow锁进入parkForeground，旧port缺isIdle不新增限制，结构busy fork仍拒绝。实际核源码/helper/真实draft store fixture并复用draft12与busy handoff119（原118+新增1），无实质未解项。未重复有效harness/冷registry/A/B/D验证。
