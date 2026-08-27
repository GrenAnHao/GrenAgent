# 项目上下文右坞设计

## 背景

当前聊天输入区上方已有工作区与 Git 状态条，应用也已有统一的右侧 Dock。TencentDB 的 Wiki、CodeGraph、记忆数据仍主要位于设置页资产中心。此次改动将项目知识入口放到聊天顶部工具栏，并复用既有右侧 Dock，同时明确 Pi 是唯一的供应商与模型来源。

## 目标

1. 在聊天顶部工具栏最右侧展示项目上下文入口。
2. 点击入口后打开或激活既有右侧 Dock 中的项目上下文标签，不创建第二套抽屉。
3. 项目上下文标签用顶部页签切换 `概览`、`Wiki`、`CodeGraph`、`记忆`、`Git`。
4. Wiki、CodeGraph、记忆和 Git 内容可被引用到当前对话。
5. TencentDB 不再提供独立的 LLM Provider/Model 配置；所有对话模型、供应商和推理档位均复用 Pi 当前会话状态。
6. 将“Agent 装备”解释为知识注入规则，避免用户误认为它是模型配置。

## 非目标

- 不重写现有 TencentDB API 或 MemoryKnowledge 服务。
- 不在抽屉内编辑供应商、API Key 或模型列表。
- 不在输入框上方增加项目上下文浮动卡片，也不改变消息发送逻辑。
- 不使用 Ant Design `Drawer`、Modal 或新的浮层承载项目上下文。
- 不在本次改动中新增独立的 CodeGraph 可视化画布。

## 交互设计

### 顶部入口

`MainColumnHeader` 的动作区最右侧显示图标入口。入口使用当前 workspace；点击后调用 Dock store 打开稳定的 `project-context` 标签。重复点击只更新当前 workspace 并激活该标签，不重复创建。`WorkspaceBar` 继续只展示工作区、分支和后台任务。

### 既有右侧 Dock

项目上下文作为现有 `DockPanel` 的一种标签内容，与工具结果和子代理共享面板宽度、折叠、排序、关闭和激活行为。Dock 顶部标签负责关闭，内容区展示项目标题、workspace 路径和二级标签栏：

- `概览`：展示 Wiki、CodeGraph、记忆、Git 的数量与状态，以及当前分支和未提交改动。
- `Wiki`：复用 `KnowledgeManager` 的 Wiki 资产、搜索、页面读取能力；结果区显示标题、摘要和内容。每个结果支持引用。
- `CodeGraph`：复用现有查询动作：搜索符号、探索代码、调用方、被调用方、影响分析、节点详情、索引状态、文件列表。结果以可滚动文本/结构化列表呈现，支持引用当前结果。
- `记忆`：查询当前项目范围的 Chat Memory/L1-L2 记忆，显示来源、时间和内容摘要，支持引用。清空或删除等管理动作仍留在资产中心，不放进聊天抽屉。
- `Git`：显示当前分支、变更文件和最近提交，复用现有 Git store 与 diff/log 能力，支持引用文件或提交摘要。

后续迭代在内容区底部提供 `引用当前内容` 和 `刷新`。没有可引用内容时引用按钮禁用。引用操作将结构化上下文写入当前编辑器的待发送上下文，不自动发送消息；用户仍可编辑后再发送。

### 数据与生命周期

项目上下文标签激活时按当前 workspace 加载概览数据；切换标签只加载对应资源。workspace 或 TencentDB 连接变化时丢弃旧请求结果，避免跨项目串数据。刷新只刷新当前标签及概览计数，不重建 Pi runtime。

## 模型与 Agent 装备

### Pi 模型统一

TencentDB 设置页移除 LLM Provider/Model、API Key 和推理档位入口。抽屉内不出现模型编辑控件；当前模型信息可作为只读上下文显示，来源为现有 Pi agent store/model selector。供应商保存、模型同步和推理档位继续由 Pi 设置与聊天输入动作负责。

### Agent 装备重命名与说明

保留现有固定资产绑定能力，但页面标题与说明改为“知识注入规则”：

- Skill、Wiki、CodeGraph、Memory 是可注入的知识资产；
- 注入模式（direct/summary/tool/reference）决定知识如何进入 Agent；
- priority 决定多个资产的注入顺序；
- 该页面不负责选择模型、供应商或密钥。

## 组件边界

- `MainHeaderActions`：渲染最右侧入口并调用 `openProjectContext(workspace)`。
- `dockStore`：维护唯一的 `project-context` 右坞标签及当前 workspace。
- `ProjectContextBody`：把 Dock 标签 payload 适配给项目面板。
- `ProjectContextPanel`：普通 Dock 内容容器、标签栏和错误/加载状态，不拥有浮层生命周期。
- `WorkspaceBar`：只负责工作区、Git 和后台任务。
- `ProjectOverviewTab`、`ProjectWikiTab`、`ProjectCodeGraphTab`、`ProjectMemoryTab`、`ProjectGitTab`：按标签封装数据加载和展示，优先复用已有 `KnowledgeManager`、TencentDB API 与 Git store。
- `AgentLoadout`：保留绑定 API，调整文案与帮助说明。

## 错误与空状态

- TencentDB 未连接：右坞项目上下文展示连接提示，不阻塞 Pi 对话。
- 单个标签请求失败：只在当前标签显示错误和重试，其他标签仍可切换。
- 无资产或无搜索结果：显示明确的空状态，不显示错误样式。
- workspace 切换期间：抽屉显示加载状态，旧项目内容立即清空。

## 验收标准

1. 项目上下文入口位于聊天顶部动作区最右侧，输入框上方不再显示项目上下文卡片。
2. 点击入口可打开或激活既有右侧 Dock 的项目上下文标签，DOM 中不存在独立 Drawer/dialog。
3. 右坞内容包含五个标签，Wiki 与 CodeGraph 能调用现有查询能力并展示结果。
4. Wiki、CodeGraph、记忆和 Git 至少各有一个“引用到当前对话”的可用路径。
5. TencentDB 设置中不存在独立 LLM 配置；聊天模型选择仍显示并使用 Pi 的供应商/模型列表。
6. Agent 装备页面明确说明其作用是知识注入规则，并保留现有绑定、模式和优先级保存能力。
7. 连接失败、空数据、切换 workspace 和刷新场景均有稳定 UI 状态。
8. 现有 TencentDB、WorkspaceBar、模型选择和相关测试全部通过。

## 测试策略

- 组件测试：顶部入口位置、Dock 标签复用、标签切换、引用按钮禁用/触发、错误与空状态。
- 数据测试：workspace 变化时旧响应不落地；刷新只更新当前作用域。
- 集成测试：Wiki/CodeGraph 查询调用既有 API；Pi 模型选择仍调用既有 `setModel` 路径。
- 回归测试：AgentLoadout 原有绑定保存、模型下拉、WorkspaceBar Git chip。
