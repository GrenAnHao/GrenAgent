# 正常 Repo Wiki 入口静态审查

## 候选与边界

2026-11-03：默认宿主 Wiki 从旧 KnowledgeKernel 切换为 `qoder-wiki-local-v1`，旧 API/cards 保留；旧 Wiki 任务和草稿为显式只读历史。修改前副本在本目录 `preimage/`。

root 负责后端/任务合同与整合；GPT-6.1 Terra `qoder_primary_entry` 负责前端；GPT-6.1 Sol `primary_entry_review` 独立静态阅读。没有运行任何测试、目标函数、类型检查、构建、UI、应用或模型。

## 发现与回修

1. **P1，start 后仍查询旧 operation：** 新 B 已创建，面板用 A 的 ID 刷新。已改为消费 start 返回 operation 并从当前分区刷新 latest；手动刷新、轮询和控制后刷新不锁旧 ID，控制动作仍绑定所见 ID。未执行 probe 包含 A→B 与外部新任务。
2. **P1，发布不刷新目录与正文：** native 状态轮询只刷新面板，旧 progress 已隔离，项目树与 revision 无更新来源。已添加 publication/projection 内容变化的只读项目刷新；面板在阅读时保持挂载。静态复审确认相同内容不重复回调，初始已有 publication 及补投影状态变化可触发，项目读取不直接写人工草稿。
3. **P2，同项目导航丢项目刷新：** 初次回修沿用包含 selectedId 的页面 epoch，切文档会丢弃在途项目响应，而 publication key 不再变化。已调整为项目/workspace/context token/language/request 身份，不包含页面导航；保存和人工草稿仍用原页面 scope。Sol 最终定向复核确认该问题解决，新增未执行 probe 覆盖延迟项目读取→同项目导航→放行→目录更新。

root 最终核对还发现既有 `RepoWikiWorkspace.test.tsx` 保留旧宿主 Wiki 的 knowledge-overview/轮询/生成断言，已由前端 owner 同步必要用例：native 主入口与任务回传、Wiki 忽略旧进度、native 后台重挂、语言选择；旧轮询/进程序号/退役任务/repair 合同移到 cards 路径保留，计划 token 和既有编辑/项目/权限用例仍在。root 阅读修改前后差分确认未删除或跳过这些覆盖，全部未执行。

## 后端静态依据

- `nativeWikiController.start` 为 `native.start` → `bridge.project` → `native.configure` → `native.dispatch`；返回 `task_id: native:<operation.id>`，失败保留确认及 request ID 以重试同一 accepted operation。
- `nativeWikiProjection` 写入 projectId，并允许同 revision 旧元数据回填；publication 与历史较新 revision 保留。
- `TaskViewStore` 转发 nativeWiki、workspace、resource.language。`KnowledgeCoordinator.snapshot` 的旧任务选择仅匹配 metadata.repoWiki.key，因此 native task 不遮蔽历史草稿。
- 后端新增两组 fixture 的接口和断言经静态阅读与实现对齐，未执行，不记通过。

## 未完成验收

生产代码本次静态审查的三项确定发现均已回修并由 Sol 定向复核，当前无未解决的已确认发现。静态阅读不覆盖构建、真实 SDK、运行调度或模型输出。

人工构建/类型/用例/UI 与真实模型验收仍是 OpenSpec 8.3/8.4；本记录不证明真实生成、发布和阅读已跑通。
