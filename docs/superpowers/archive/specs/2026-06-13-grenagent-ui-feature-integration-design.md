# GrenAgent · 8 功能界面集成设计

- 日期：2026-06-13
- 状态：已通过头脑风暴评审，待实现
- 相关：`extensions/`（8 个 extension）、`cli/`（sidecar）、`tauri-agent/`（GrenAgent 前端 + Rust）
- 原型：`.superpowers/brainstorm/grenagent-ui/content/*.html`（原型中的 emoji 仅为草图占位，实现一律用 SVG icon，见 §9.1）

## 1. 背景与目标

GrenAgent 是基于 pi 的 Tauri 桌面编码 agent。已把 8 个 extension（knowledge-rag、long-term-memory、web-fetch、image-gen、code-review、multi-agent、tts、im-gateway）编译进 sidecar（见 `cli/`），agent 运行时即可调用其工具/命令。

本设计解决：**这 8 个功能在 GrenAgent 桌面界面上如何组织、呈现、被用户使用。**

成功标准：

- 8 个功能都有明确的界面归属，用户能找到、能用。
- agent 自动调用的结果与用户手动管理**两者并重**（用户的明确诉求）。
- 不推翻现有「聊天为中心」的能力，渐进可落地。

## 2. 设计决策

**采用方案 B：左侧模块导航（多视图工作台）。**

评审中对比过三种方案：A（右面板 Tab 化）、B（左侧模块导航）、C（聊天为中心 + 右面板 Tab）。用户选择 B —— 把每个功能当作可独立展开的工作台模块，空间充足、可扩展，契合「完整面板体系」。

- 否决 A/C 的原因：右面板 Tab 承载 3+ 管理视图会拥挤；GrenAgent 定位是「多合一工作台」而非仅聊天窗口。
- 保留 B 的同时，吸收 C 的优点：**对话模块内**保留输入区快捷入口与工具卡片内联（见 §6）。

## 3. 信息架构（7 模块）

左侧新增**模块导航栏**（窄图标栏，约 56–60px），切换中央主视图。图标统一用 lucide-react SVG（见 §9.1）：

| 模块 | lucide 图标 | 承载 |
|---|---|---|
| 对话 | `message-square` | 聊天 + web-fetch / multi-agent / tts 工具卡片 + 知识/记忆自动注入提示 |
| 知识库 | `library` | knowledge-rag 管理 |
| 记忆 | `brain` | long-term-memory 管理（项目 + 全局） |
| 审查 | `file-search` | code-review |
| 创作 | `image` | image-gen（未来可扩展 video/音频） |
| 连接 | `plug` | im-gateway 网关与平台接入 |
| 设置 | `settings` | 各 extension 的 key / 开关集中管理 |

**取舍**：web-fetch / multi-agent / tts 不单独成模块 —— 它们是「即时动作」而非「需要管理的数据」，归入对话模块作为工具。

**管理视图统一范式**：知识库 / 记忆 / 审查 / 创作 四个管理模块共用「**顶部状态+操作 / 左列表 / 右详情**」骨架，只换内容，降低实现与认知成本。

## 4. 各模块设计

### 4.1 对话（icon: message-square）

现有 `features/chat` 基础上增强：

- **会话列表**：沿用现有 `Sidebar`（按项目分组、运行中状态点）。模块导航栏在会话列表更左侧，二者并存。
- **消息流**：现有 `MessageList` + `ToolExecution` 卡片渲染，新增对新工具的专用渲染（§6）。
- **自动注入提示**：消息流相应轮次插入轻量提示条「已注入 N 条记忆 · M 条知识片段」，来源是 `before_agent_start` 注入的 `customType` 消息（knowledge-rag / long-term-memory）。
- **输入区快捷**：`ActionBar` 增加 `+知识库`（把当前文件/选区 kb_add）、`生图`、`朗读`，与现有 模型/thinking/上传/compact 并列；按钮用 lucide 图标。

### 4.2 知识库（icon: library）

- 顶部：状态（chunks / 文档数、检索模式 semantic|keyword）+ 操作 `添加文档` `重索引` `清空`。
- 左列表：已索引文档（source + chunks 数 + 时间）；顶部「测试检索」框，输入即看命中片段。
- 右详情：选中文档的 chunks 预览（带 score）。
- 数据来源：sidecar 内 knowledge-rag 的 `<cwd>/.pi/knowledge/default.db`。

### 4.3 记忆（icon: brain）

- 顶部：状态（项目 N / 全局 M）+ `scope 筛选` `手动添加` `清空`。
- 左列表：记忆条目（text + category 标签 + scope 标签 + 来源：手动 / 「记住：」捕获 / 对话提取）。
- 右详情：完整 text + 元信息 + `编辑` `删除` `提升为全局` + 「被召回 N 次」命中统计。
- 数据来源：项目 `<cwd>/.pi/memory/memory.db` + 全局 `~/.pi/agent/long-term-memory.db`。

### 4.4 审查（icon: file-search）

- 顶部：diff 源选择（工作区 / staged / vs 分支）+ `让 agent 审查` `生成报告`。
- 左列表：发现按 severity 分组（blocker/major/minor/nit/praise，带色点 + file:line）。
- 右详情：对应 diff 片段 + 建议 + `标记已解决` `在对话里修`。
- 数据来源：code-review 的 `git_diff` / `review_note`（`.pi/reviews/reviews.db`）/ `report`。

### 4.5 创作（icon: image）

- 顶部：状态（本项目图片数、model）+ 尺寸选择。
- 主体：生图画廊网格（缩略图 + prompt + 时间）。
- 底部：prompt 输入 + `生成`（也可在对话 `生图` 快捷）。
- 数据来源：image-gen 保存的 `.pi/images/*.png`。

### 4.6 连接（icon: plug）

- 顶部：网关运行状态 + 端口 + `启动/停止`。
- 网关卡：监听地址、Webhook 路径、Token（显示/重置/复制）。
- 平台接入列表：Slack / 飞书 / Telegram（已连/未配 + `配置`）。adapter 把平台事件转发到 Webhook，回复回 POST。
- 数据来源：im-gateway（`IM_GATEWAY*` 环境/设置）。

### 4.7 设置（icon: settings）

- 左分类：通用/模型、Embedding、知识库、记忆、图像生成、语音 TTS、连接/安全。
- 右表单：每个 extension 的 env 开关/参数对应表单项（如 `KB_AUTO_INJECT`、`KB_AUTO_TOPK`、`MEMORY_AUTO_*`、`IMAGE_*`、`TTS_*`、`IM_GATEWAY*`、Embedding key/baseUrl/model）。
- 落点：写入 GrenAgent 自己的设置存储；spawn sidecar 时通过 `env` 注入（见 §8）。

## 5. 8 功能 → UI 映射

| 功能 | 主入口 | 形态 |
|---|---|---|
| knowledge-rag | 知识库模块 + 对话自动注入 + 输入区 `+知识库` | 管理视图 + 工具卡片 + 提示条 |
| long-term-memory | 记忆模块 + 对话自动注入 | 管理视图 + 提示条 |
| code-review | 审查模块 | 管理视图 |
| image-gen | 创作模块 + 对话 `生图` | 画廊 + 工具卡片 |
| web-fetch | 对话工具 | 工具卡片（抓取结果） |
| multi-agent | 对话工具 | 工具卡片（子 agent 树） |
| tts | 对话工具 + 输入区 `朗读` | 播放按钮/卡片 |
| im-gateway | 连接模块 | 网关 + 平台管理 |

## 6. 对话内工具卡片 & 自动注入

新工具的 `ToolExecution` 专用渲染（沿用现有工具卡片机制，按 `toolName` 分派；卡片头部图标用 lucide）：

| 工具 | lucide 图标 | 卡片内容 |
|---|---|---|
| `kb_search` | `search` | 命中片段列表（source + score + 文本） |
| `kb_add` | `book-plus` | 索引结果（source + chunks 数 + embedded/keyword） |
| `memory_save` / `memory_recall` | `brain` | 保存确认 / 召回条目 |
| `generate_image` | `image` | 图片缩略图 + prompt + 保存路径，点击放大 |
| `spawn_agent` | `network` | 子 agent 树（任务 + 状态 + 输出折叠） |
| `fetch_url` | `globe` | 来源 URL + 标题 + markdown 摘要 |
| `speak` | `volume-2` | 音频播放控件（路径 + 播放） |

自动注入提示：knowledge-rag / long-term-memory 的 `before_agent_start` 注入消息（`customType: "knowledge-rag" | "long-term-memory"`，`display:true`）在前端识别为「注入提示条」而非普通消息渲染（提示条左侧用 lucide `sparkles` 图标）。

## 7. 前端组件设计（在 `tauri-agent/src/` 内）

遵循现有 `features/<domain>` 结构，新增：

- `features/layout/ModuleRail.tsx` — 左侧模块导航栏（lucide 图标 + 高亮 + 切换）。
- `features/workspace/` — 模块路由/容器：按当前模块渲染对应主视图。
- `features/knowledge/KnowledgePanel.tsx`、`features/memory/MemoryPanel.tsx`、`features/review/ReviewPanel.tsx`、`features/create/CreatePanel.tsx`、`features/connections/ConnectionsPanel.tsx`、`features/settings/SettingsPanel.tsx`。
- 各管理面板复用一个 `features/common/ManagerLayout.tsx`（顶操作 + 左列表 + 右详情）以统一范式。
- `features/chat/tools/` 下新增各工具卡片渲染组件（kb/memory/image/subagent/fetch/speak）。
- `ActionBar` 增加快捷按钮（lucide 图标）。

状态：新增一个 `moduleStore`（当前激活模块）；各面板数据走 §8 的 RPC 命令，沿用现有 store 模式（vanilla store + 订阅）。

> 现有代码改进（顺手）：`App.tsx` 的 `Workspace` 布局需在最左插入 `ModuleRail`，并把「中央区」抽象为按模块切换的容器，避免把所有面板塞进一个组件。

## 8. 数据流与 RPC 接线

GrenAgent 前端 ─IPC→ Rust（`pi/sidecar.rs`）─JSONL→ sidecar（pi + 8 extension）。

- **agent 自动调用工具**：走现有 RPC 事件流，工具结果事件到达前端 → 按 `toolName` 渲染卡片。**无需新增协议**。
- **管理面板读写数据**：两条可选路径，实现时按模块定：
  1. **复用工具/命令**：面板操作 = 让 sidecar 执行对应工具（如知识库「添加」= 调 `kb_add`），结果回流。改动小、复用 RPC。
  2. **Rust 直读 sqlite**：面板只读展示时，Rust 直接读 `.pi/*.db`（node:sqlite 写、Rust rusqlite 读），更快但需保证 schema 同步。
  - 建议：**读多用路径 2（直读快），写用路径 1（经 extension 保证一致）**。
- **设置**：保存到 GrenAgent 设置存储；下次 spawn sidecar 时由 `pi/sidecar.rs` 注入 `env`（`OPENAI_API_KEY`、`KB_*`、`MEMORY_*`、`IMAGE_*`、`TTS_*`、`IM_GATEWAY*`）。
- **连接（im-gateway）**：sidecar 内 webhook server；前端通过设置开启（env `IM_GATEWAY=1` + 端口/token），连接模块展示状态。

## 9. 设计语言

- 沿用现有暗色主题与 `@lobehub/ui` / antd 组件、`themeStore` 注入的 CSS 变量。
- 模块栏图标 + 高亮（左侧色条）；管理视图统一圆角/间距/层次（原型已体现）。
- 工具卡片：统一头部（图标 + 工具名 + 状态）+ 内容区。

### 9.1 图标规范（重要）

- **全程使用 SVG 图标，禁止使用 emoji**（包括模块栏、工具卡片、按钮、状态点、空状态等所有位置）。
- 统一用 **`lucide-react`**（`tauri-agent` 已在依赖中）。用法：`import { MessageSquare } from 'lucide-react'` 然后 `<MessageSquare size={18} />`，颜色继承 `currentColor`，受主题 CSS 变量控制。
- 图标映射见 §3（模块）与 §6（工具卡片）的「lucide 图标」列；其它常用：注入提示 `sparkles`、运行中状态 `circle`(填充)、上传 `paperclip`、模型 `zap`、发送 `send`、新建 `plus`、删除 `trash-2`、编辑 `pencil`、复制 `copy`。
- severity 色点用同一 `circle` 图标 + 不同颜色（blocker/major/minor/nit/praise）。
- 原型 HTML 里的 emoji 仅为草图占位，落地时一律替换为对应 lucide 组件。

## 10. 实现分期（建议顺序）

1. **骨架**：`ModuleRail`（lucide 图标）+ 模块容器 + `moduleStore`，空面板占位（验证导航）。
2. **对话增强**：新工具卡片渲染 + 自动注入提示条 + 输入区快捷（价值最高、复用现有聊天）。
3. **知识库 / 记忆面板**：管理视图范式（`ManagerLayout`）落地一次，两个面板复用。
4. **审查 / 创作面板**。
5. **连接 / 设置面板**：含 sidecar env 注入打通。

每期可独立交付、独立验证。

## 11. 非目标（YAGNI）

- 不做多窗口/可拖拽自定义布局（先固定 B 布局）。
- 不在本期实现 sqlite-vec、video 生成、完整 IM adapter（连接模块先到「网关 + 状态 + 接入指引」）。
- 管理面板的读写路径（§8 路径 1 vs 2）在实现计划里按模块决定，不在设计阶段过度规定。

## 附：原型对照

- 对话模块：`b-realistic.html`
- 知识库：`module-knowledge.html`
- 记忆/审查/创作：`modules-mem-review-create.html`
- 连接/设置：`modules-conn-settings.html`

（原型用 emoji 仅为草图；实现按 §9.1 用 lucide SVG。）
