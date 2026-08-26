# 项目上下文浮动卡片与右侧抽屉设计

## 背景

当前聊天输入区上方已有工作区与 Git 状态条，但 TencentDB 的 Wiki、CodeGraph、记忆数据仍主要位于设置页资产中心。LLM 配置也容易被理解为 TencentDB 的独立配置。此次改动将项目知识入口放到聊天上下文中，同时明确 Pi 是唯一的供应商与模型来源。

## 目标

1. 在聊天输入框外、输入框上方、与工作区/分支条同层展示轻量项目浮动卡片。
2. 点击卡片后从右侧滑出项目详情抽屉。
3. 抽屉用顶部标签切换 `概览`、`Wiki`、`CodeGraph`、`记忆`、`Git`。
4. Wiki、CodeGraph、记忆和 Git 内容可被引用到当前对话。
5. TencentDB 不再提供独立的 LLM Provider/Model 配置；所有对话模型、供应商和推理档位均复用 Pi 当前会话状态。
6. 将“Agent 装备”解释为知识注入规则，避免用户误认为它是模型配置。

## 非目标

- 不重写现有 TencentDB API 或 MemoryKnowledge 服务。
- 不在抽屉内编辑供应商、API Key 或模型列表。
- 不把项目卡片嵌入文本编辑器或改变消息发送逻辑。
- 不在本次改动中新增独立的 CodeGraph 可视化画布。

## 交互设计

### 浮动项目卡片

`WorkspaceBar` 继续位于输入区上方。其左侧新增可点击的项目上下文卡片，卡片与工作区名称、分支 chip、后台任务 chip 同层排列。卡片显示：

- 项目名称（由 workspace 路径末段得到）；
- Wiki 页数、CodeGraph 规模、项目记忆数量；
- 知识同步状态或不可用状态。

卡片不进入编辑器 DOM，不占用输入内容区域。无 workspace、当前为会话目录或 TencentDB 不可用时，卡片隐藏或降级为不可用状态，不影响输入框。

### 右侧抽屉

抽屉从聊天窗口右侧滑入，保留当前对话和输入框可见。顶部固定项目标题、workspace 路径、同步时间、刷新按钮和关闭按钮。第二行是顶部标签栏：

- `概览`：展示 Wiki、CodeGraph、记忆、Git 的数量与状态，以及当前分支和未提交改动。
- `Wiki`：复用 `KnowledgeManager` 的 Wiki 资产、搜索、页面读取能力；结果区显示标题、摘要和内容。每个结果支持引用。
- `CodeGraph`：复用现有查询动作：搜索符号、探索代码、调用方、被调用方、影响分析、节点详情、索引状态、文件列表。结果以可滚动文本/结构化列表呈现，支持引用当前结果。
- `记忆`：查询当前项目范围的 Chat Memory/L1-L2 记忆，显示来源、时间和内容摘要，支持引用。清空或删除等管理动作仍留在资产中心，不放进聊天抽屉。
- `Git`：显示当前分支、变更文件和最近提交，复用现有 Git store 与 diff/log 能力，支持引用文件或提交摘要。

抽屉底部固定操作栏提供 `引用当前内容` 和 `刷新`。没有可引用内容时引用按钮禁用。引用操作将结构化上下文写入当前编辑器的待发送上下文，不自动发送消息；用户仍可编辑后再发送。

### 数据与生命周期

抽屉打开时按当前 workspace 加载概览数据；切换标签只加载对应资源。workspace、会话或 TencentDB 连接变化时丢弃旧请求结果，避免跨项目串数据。刷新只刷新当前标签及概览计数，不重建 Pi runtime。

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

- `WorkspaceBar`：渲染浮动卡片、维护打开/关闭状态，不负责详情查询。
- `ProjectContextCard`：只渲染项目摘要与状态，接收 workspace 统计数据。
- `ProjectContextDrawer`：抽屉壳、标签栏、底部引用栏和错误/加载状态。
- `ProjectOverviewTab`、`ProjectWikiTab`、`ProjectCodeGraphTab`、`ProjectMemoryTab`、`ProjectGitTab`：按标签封装数据加载和展示，优先复用已有 `KnowledgeManager`、TencentDB API 与 Git store。
- `AgentLoadout`：保留绑定 API，调整文案与帮助说明。

## 错误与空状态

- TencentDB 未连接：卡片显示“知识未连接”，抽屉可打开并展示连接提示与重试，不阻塞 Pi 对话。
- 单个标签请求失败：只在当前标签显示错误和重试，其他标签仍可切换。
- 无资产或无搜索结果：显示明确的空状态，不显示错误样式。
- workspace 切换期间：抽屉显示加载状态，旧项目内容立即清空。

## 验收标准

1. 项目卡片位于输入框外部、输入框上方，并与现有工作区/分支 chip 同层。
2. 点击卡片可打开右侧抽屉，关闭后聊天输入内容和滚动位置保持不变。
3. 抽屉包含五个标签，Wiki 与 CodeGraph 能调用现有查询能力并展示结果。
4. Wiki、CodeGraph、记忆和 Git 至少各有一个“引用到当前对话”的可用路径。
5. TencentDB 设置中不存在独立 LLM 配置；聊天模型选择仍显示并使用 Pi 的供应商/模型列表。
6. Agent 装备页面明确说明其作用是知识注入规则，并保留现有绑定、模式和优先级保存能力。
7. 连接失败、空数据、切换 workspace 和刷新场景均有稳定 UI 状态。
8. 现有 TencentDB、WorkspaceBar、模型选择和相关测试全部通过。

## 测试策略

- 组件测试：项目卡片显示条件、抽屉开关、标签切换、引用按钮禁用/触发、错误与空状态。
- 数据测试：workspace 变化时旧响应不落地；刷新只更新当前作用域。
- 集成测试：Wiki/CodeGraph 查询调用既有 API；Pi 模型选择仍调用既有 `setModel` 路径。
- 回归测试：AgentLoadout 原有绑定保存、模型下拉、WorkspaceBar Git chip。
