# 会话底层工作流 checkpoint

用户已撤回本轮新增的桌面会话面板／入口，不再需要桌面会话树。当前不通过该抽屉交付上下文编辑或导入／导出 UI。以下记录保留的底层数据、兼容接缝与验证结果，不是当前产品按钮使用指南。

## 保留的数据与既有契约

- 既有 fork-only／switch-only ports 保持原契约。真实 WorkspaceHandle 可通过 staged handoff 增强，候选完成前不替换源 handle；源后台任务与事件 owner 不搬到新会话。
- 操作绑定 sessionPath、identity、leaf 和 revision。位置记录含 null-root；截断使锚点失效时回到存在的节点。只读历史读取也使用已确认位置，不构造 runtime。
- 当前分支原始历史与有效模型上下文分离。native omit 和压缩窗口不删除原始消息展示数据；内容恢复追加完整非 null 原文，再公开 refreshContext，不改历史模型、签名、工具关联或 usage。
- 旧 timestamp/custom 排除仍按全日志语义，不迁移为 native。副本只补等价 add/remove 和本机已确认的 pulse revision，不携带旁支正文，不信任导入文件自带的确认 revision。
- 保存后刷新失败关闭继续发送，按已保存状态从盘恢复，不重复追加。候选记录区分 prepared、published、selected，未完成发布不可发送。

## 保留的文件与信任边界

HTML 保留 SDK 完整树快照、敏感原文和离线 viewer；JSONL 仅保留当前分支、适用书签与 canonical 偏好，二者都不含未落盘草稿。上下文替换不是脱敏，底层不自动上传或分享。

严格导入在数据阶段逐行检查版本、ID、父链、内容角色和必需字段、编辑目标、工具配对及大小界限。合法版本 1/2 的已知迁移只在内存／候选执行；不容错跳坏行，不跟随 parentSession 或 URL。助手原始消息使用内容块数组及完整 API／provider／model／usage／stopReason；工具结果包含数组内容、关联字段和 isError；合法 system／压缩检查点保留。

候选使用本地可信资源与已确认目录，不执行历史工具、扩展或配置声明，不写凭据或信任，不自动继续或预热。缺失模型保留 unavailable；审批／模式不因文件声明升权。导入历史经观测 owner 的 prepare/commit/abort port 标为 external-history，受管继承归原可信调用；缺 registry 为 unverified，不猜新身份旧费用，之后真实新请求正常登记。

## 有效证据

`.agents/evidence/2026-11-10-complete-desktop-session-workflows/` 保留第五真实生产字节码 IPC 的 35 个底层断言、实际 SDK HTML 离线 8 项、故障恢复、严格 schema、旧 port 兼容及类型基线对照。冷恢复后真实新请求等待其新持久终态 entry 和随后 settled，累计硬断言为 35 tokens／3 条。

原三个 UI 场景和截图仅作为已撤回候选的历史记录保留，不表示当前可见功能，也不把原 OpenSpec 的 35 项桌面任务标为完整交付。未提交、推送、归档或发布；未重启正式应用，未使用真实凭据或付费远程模型。
