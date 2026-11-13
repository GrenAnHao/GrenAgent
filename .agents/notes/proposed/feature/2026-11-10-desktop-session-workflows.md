# Agent Note: 桌面会话树、内容投影与本地便携文件

Status: proposed

## Problem

用户随后明确不需要会话树，并撤回本轮新增的会话面板／入口及请求／缓存预热详情入口。root 已移除 ChatView 中两组挂载；本记录停在安全 checkpoint，不转 implemented，不把原 35 项桌面功能标为已交付，不继续打磨树 UI。

底层严格导入、当前分支历史保真、candidate 恢复、来源兼容和既有 entry/port 契约保留。上下文编辑与导入／导出虽然有底层验证，当前没有本轮抽屉的可见入口，UI 不交付。原候选的 UI 截图和测试仅是历史证据。

## Current constraints

SDK 的同文件导航、独立分叉和 append-only 内容编辑缺少桌面 owner、恢复位置及不可信文件边界；直接替换 live runtime 会在构造失败时拆坏源。旧 timestamp 排除实际回放全日志，单独复制当前路径会改变可见上下文。

## Proposal

保留已实现并验证的底层接缝：使用显式 sessionPath/identity/leaf/revision 的单一生产 IPC；每个 owner 串行且忙时拒绝。最后确认位置独立保存，含 null-root。内容恢复追加原始完整非 null content 并公开 refreshContext；旧排除保持全日志语义，不迁移 native。派生与导入先准备 candidate、canonical 五项偏好、usage_origin_required 标记及观测 owner 的 prepare/commit/abort 来源记录，再发布并切前景；失败源仍可用，已追加未刷新关闭发送门。

JSONL 只导当前分支，补有效书签、canonical 和源全日志旧排除快照；只在副本补 add/remove，不带旁支正文。导入先严格解析数据，不运行历史携带的资源、配置或请求。HTML 导出全树且离线隔离历史内容。外部历史仅展示，不凭文件声明授信账本。

## Existing decisions

2026-10-18 rewind 笔记保留真截断语义，与本次导航独立；2026-10-28 session-preferences/session-fast-mode 保留五项 owner 契约，派生显式使用操作时快照。检索命中的 archive/cwd/subagent/agentdata/repo-wiki 笔记与本次决定无重合，不修改。

## Alternatives considered

直接 SDK fork 能复用默认实现，但 teardown 先于构造，失败无法保证源可用，因此用 staged handoff。只复制路径改动最少，但路径外旧 add/remove 影响当前上下文，因此副本追加等价旧层补偿。null 恢复写法最短，但 SDK 将其解释为 omit，因此恢复完整原文。自行加一套来源账本可以独立开发，但会分裂可信身份，故只调用观测 owner port。

## Acceptance criteria

底层证据保留在 `.agents/evidence/2026-11-10-complete-desktop-session-workflows/`：真实 SDK、生产 IPC、失败恢复与类型基线有效；第五候选 35 个底层断言通过，不等于原 35 项桌面任务交付。已运行的三个 UI 场景属于撤回方案的历史候选，不继续作为当前 UI 交付验收。

## Risks

位置文件与日志不原子；只提交已确认位置，半成功显式提示并阻止旧上下文发送。来源 port 未联通前不启用 fork/clone/import。HTML 和 JSONL 都保留敏感原文，不是脱敏格式。
