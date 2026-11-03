# 独立审阅与修订记录

对象：`.agents/notes/proposed/architecture/2026-11-03-agentdata-lightweight-decoupling-review.md`。

审阅者未参与原始调查/方案编写，使用当前实际源码抽查，未运行产品代码或模型。

结论：没有推翻总体方向的 Critical。四项会改变实施拆分的合同问题及一项兼容建议均已采纳并写入当前文档：

1. **共享准入权威**：现状补充 NativeWikiProjection 中 scope/lease_id/pinned 的安全职责；目标明确 agentdata-host 的单一 scope 准入 repository，Native/Kernel/无模型补投影共用；展示投影重建不能释放活跃锁。
2. **版本分离**：控制 CAS 使用 ownerOperationRevision，完整展示使用 viewVersion；同 operation revision 下的 stage、健康和投影变化继续推进展示版本；明确 epoch 变化与快照对账。
3. **资料 3a/3b 独立合同**：3a 新增非破坏性 abort/drain、interrupted、可能已部分修改正式文件的披露和本地对账；不复用现有删除库清理逻辑。3b 才具备 staged/journal/receipt 与上一正式发布恢复承诺。
4. **模型不确定窗口**：派发前最小请求身份/状态，崩溃 dispatched 转 unknown，不自动重发；可能再计费需确认。验收限定为重复接受幂等、本地补偿不调用模型、unknown 如实保留，不宣称真实供应商端到端只执行一次。
5. **历史任务适配**：增加 legacy-readonly 读取适配及旧 source/id 稳定映射，未知 kind/存量 service_tasks 保留历史/导航，不增执行器、不猜控制动作。

主代理另直接核查了 `nativeWikiProjection.ts:11–39`、`main.ts:404–410`、`wikiEngine/service.ts:1181–1233`、`ingest/runIncremental.ts:116–125` 等支撑路径。

没有因审阅产生新的必答产品问题；原稿 D1–D5 与待补规模/外部调用者保持待评审状态。
