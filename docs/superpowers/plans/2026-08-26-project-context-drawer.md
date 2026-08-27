# 项目上下文浮动卡片与右侧抽屉实现计划

> **2026-08-27 架构修订：** 用户否决输入框上方浮动卡片和独立 Drawer。任务 2、3 的原承载方式已废弃。严格迭代第 1 轮改为：入口移动到 `MainColumnHeader` 动作区最右侧；`dockStore` 新增唯一的 `project-context` 右坞标签；`ProjectContextPanel` 作为既有 `DockPanel` 的普通内容渲染；`WorkspaceBar` 恢复只展示工作区、Git 与任务。后续任务 4-6 的数据与引用目标不变，但所有“抽屉”均指该右坞内容。

## 严格迭代状态

- [x] 第 1 轮：入口右移、复用既有右坞、移除浮动卡片与独立 Drawer。
- [ ] 第 2 轮：记忆、Git 与固定引用栏。
- [ ] 第 3 轮：移除 TencentDB 独立 LLM 配置，调整为 Pi 模型统一。
- [ ] 第 4 轮：将 Agent 装备改为知识注入规则并完成全量回归。

> **面向 AI 代理的工作者：** 必需子技能：使用 \`superpowers:subagent-driven-development\`（推荐）或 \`superpowers:executing-plans\` 逐任务实现此计划。步骤使用复选框（\`- [ ]\`）语法来跟踪进度。

**目标：** 在聊天输入框外的 WorkspaceBar 同层加入项目上下文浮动卡片，并实现带 \`概览 / Wiki / CodeGraph / 记忆 / Git\` 标签的右侧详情抽屉；TencentDB 不再维护独立 LLM 配置，AgentLoadout 明确为知识注入规则。

**架构：** \`WorkspaceBar\` 只负责项目 chip 与抽屉开关，\`ProjectContextDrawer\` 负责抽屉壳、标签和引用回调，各标签组件按 workspace 作用域加载已有 TencentDB/Git 数据。引用内容通过聊天输入上下文新增的 \`addPastedText\` 进入待发送引用，不自动发送；Pi 的模型状态继续由现有模型选择器提供。

**技术栈：** React 19、TypeScript、Ant Design 6、antd-style、@lobehub/ui、lucide-react、Vitest、Testing Library、Tauri invoke API。

---

## 文件与职责

**新增：**

- \`tauri-agent/src/features/chat/input/workspace/ProjectContextCard.tsx\`：渲染项目名称、知识计数和同步状态，点击触发抽屉。
- \`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.tsx\`：右侧抽屉容器、标签栏、刷新/引用底栏和作用域生命周期。
- \`tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx\`：五个标签的数据适配；复用已有 Wiki/CodeGraph 查询能力，不把设置页 KnowledgeManager 直接嵌入聊天布局。
- \`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`：卡片、抽屉、标签、引用和错误状态测试。

**修改：**

- \`tauri-agent/src/features/chat/input/workspace/WorkspaceBar.tsx\`：加载当前 workspace 的 TencentDB 知识摘要，加入卡片和抽屉挂载点。
- \`tauri-agent/src/features/chat/input/workspace/styles.ts\`：新增卡片和抽屉布局样式，抽屉宽度使用 \`min(520px, 92vw)\`，不改变已有 chip 样式。
- \`tauri-agent/src/features/chat/input/editor/MessageEditor.tsx\`：把 \`addPastedText\` 传给 WorkspaceBar，使抽屉引用可进入当前编辑器上下文；WorkspaceBar 仍渲染在 surface 外部。
- \`tauri-agent/src/features/chat/input/ChatInputContext.tsx\`：仅在类型/上下文契约已经缺失时补充引用回调类型，保持现有 \`PastedText\` 结构。
- \`tauri-agent/src/features/tencentdb/AgentLoadout.tsx\`：标题、说明和保存按钮文案改为“知识注入规则”，解释 injection mode/priority，不改绑定 API。
- \`tauri-agent/src/features/tencentdb/AgentLoadout.test.tsx\`：更新文案断言，增加装备职责说明断言。
- \`tauri-agent/src/lib/tencentdb.ts\`：若抽屉需要项目记忆摘要而现有 core route 未覆盖，则只补充查询所需的已有 count/search 类型，不添加新的服务端路由。

---

### 任务 1：建立引用输入契约

**文件：**
- 修改：\`tauri-agent/src/features/chat/input/editor/MessageEditor.tsx\`
- 可能修改：\`tauri-agent/src/features/chat/input/ChatInputContext.tsx\`
- 测试：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

- [ ] **步骤 1：编写失败测试**

在测试中构造 \`addPastedText\` spy，渲染抽屉并点击“引用当前内容”，断言回调收到 \`PastedText\`：

\`\`\`tsx
expect(addPastedText).toHaveBeenCalledWith(expect.objectContaining({
  text: expect.stringContaining('CodeGraph'),
  referenceOnly: true,
}));
\`\`\`

- [ ] **步骤 2：运行测试确认失败**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

预期：FAIL，提示抽屉组件或引用回调尚未定义。

- [ ] **步骤 3：实现最小契约**

复用 \`editor/types.ts\` 的 \`PastedText\`，让 \`MessageEditor\` 将 \`addPastedText\` 作为 prop 传给 \`WorkspaceBar\`；不要新增全局 store。引用内容统一调用：

\`\`\`ts
addPastedText({
  id: \`project-context-\${Date.now()}\`,
  text: content,
  source: \`project://\${workspace}/\${kind}\`,
  referenceOnly: true,
});
\`\`\`

- [ ] **步骤 4：运行测试确认通过**

运行同上，预期该测试 PASS。

- [ ] **步骤 5：提交**

\`\`\`bash
git add tauri-agent/src/features/chat/input/editor/MessageEditor.tsx tauri-agent/src/features/chat/input/ChatInputContext.tsx tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx
git commit -m "feat: connect project context citations to chat input"
\`\`\`

### 任务 2：项目摘要卡片与 WorkspaceBar 开关

**文件：**
- 创建：\`tauri-agent/src/features/chat/input/workspace/ProjectContextCard.tsx\`
- 修改：\`tauri-agent/src/features/chat/input/workspace/WorkspaceBar.tsx\`
- 修改：\`tauri-agent/src/features/chat/input/workspace/styles.ts\`
- 测试：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

- [ ] **步骤 1：编写失败测试**

覆盖三个状态：普通 workspace 显示项目名和 chip；会话目录不显示；TencentDB 未连接时显示“知识未连接”但仍可点击打开抽屉。

\`\`\`tsx
expect(screen.getByRole('button', { name: /JSReverser-MCP/ })).toBeTruthy();
expect(screen.getByText(/知识未连接/)).toBeTruthy();
\`\`\`

- [ ] **步骤 2：运行测试确认失败**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

预期：FAIL，找不到项目上下文按钮。

- [ ] **步骤 3：实现卡片**

在 \`WorkspaceBar\` 保持现有 Git 刷新逻辑，增加 \`useTencentdbConnection()\` 与 \`tencentdbApi.listKnowledgeAssets(workspace)\` 的作用域请求；响应只保留当前 workspace，计数来自 \`wikis.length\`、CodeGraph \`stats\` 和当前项目记忆摘要。卡片使用 \`button\` 语义和 \`aria-label\`，不放进 \`surface\`。

- [ ] **步骤 4：运行测试确认通过**

运行同上，预期卡片状态测试 PASS；再运行 \`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/WorkspaceBar.test.tsx\`，预期既有 WorkspaceBar 测试 PASS。

- [ ] **步骤 5：提交**

\`\`\`bash
git add tauri-agent/src/features/chat/input/workspace/ProjectContextCard.tsx tauri-agent/src/features/chat/input/workspace/WorkspaceBar.tsx tauri-agent/src/features/chat/input/workspace/styles.ts tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx
git commit -m "feat: add project context card above chat input"
\`\`\`

### 任务 3：右侧抽屉壳与五标签生命周期

**文件：**
- 创建：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.tsx\`
- 创建：\`tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx\`
- 修改：\`tauri-agent/src/features/chat/input/workspace/WorkspaceBar.tsx\`
- 修改：\`tauri-agent/src/features/chat/input/workspace/styles.ts\`
- 测试：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

- [ ] **步骤 1：编写失败测试**

断言打开后显示标题和五个标签；切换标签只渲染当前标签；关闭后抽屉和内容消失；workspace 变化时旧内容不继续显示。

\`\`\`tsx
fireEvent.click(screen.getByRole('button', { name: /JSReverser-MCP/ }));
expect(screen.getByRole('dialog', { name: 'JSReverser-MCP 项目上下文' })).toBeTruthy();
expect(screen.getByRole('tab', { name: 'Wiki' })).toBeTruthy();
\`\`\`

- [ ] **步骤 2：运行测试确认失败**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

预期：FAIL，抽屉角色和标签尚未存在。

- [ ] **步骤 3：实现最小抽屉**

使用现有 antd \`Modal\` 的 \`open\`/\`title\`/\`footer\` 能力或项目已有 overlay 约定实现右侧滑入；若使用 Modal，设置 \`wrapClassName\` 和 \`styles.content\` 做右侧固定宽度，不引入新的 drawer 依赖。标签采用 \`role="tablist"\` 与 \`role="tab"\`。每次打开/切换 workspace 清空 active content；请求用 generation/ref 校验，旧响应直接丢弃。

- [ ] **步骤 4：运行测试确认通过**

运行同上，预期抽屉开关、标签和 stale response 测试 PASS。

- [ ] **步骤 5：提交**

\`\`\`bash
git add tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.tsx tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx tauri-agent/src/features/chat/input/workspace/WorkspaceBar.tsx tauri-agent/src/features/chat/input/workspace/styles.ts tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx
git commit -m "feat: add project context drawer shell"
\`\`\`

### 任务 4：Wiki、CodeGraph 与概览数据

**文件：**
- 修改：\`tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx\`
- 修改：\`tauri-agent/src/features/tencentdb/tencentdbApi.tsx\`（仅补充类型导出时）
- 测试：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

- [ ] **步骤 1：编写失败测试**

mock 既有 \`listKnowledgeAssets\`、\`listWikiPages\`、\`searchWiki\`、\`readWikiPages\` 和 CodeGraph 查询方法，断言概览计数、Wiki 搜索结果、CodeGraph 查询结果和各自引用按钮。

- [ ] **步骤 2：运行测试确认失败**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

预期：FAIL，标签内容和 API 调用尚未实现。

- [ ] **步骤 3：实现 Wiki/CodeGraph**

Wiki 标签至少支持搜索、读取页面、展示内容和引用；CodeGraph 标签复用 \`KnowledgeManager\` 已有 action 集合，默认搜索符号，结果限制在抽屉滚动区，引用传入当前查询结果文本和 \`project://\` source。概览从同一份知识资产响应计算数量，避免重复请求。

- [ ] **步骤 4：运行测试确认通过**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

预期 Wiki、CodeGraph、概览测试 PASS。

- [ ] **步骤 5：提交**

\`\`\`bash
git add tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx tauri-agent/src/features/tencentdb/tencentdbApi.tsx tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx
git commit -m "feat: show wiki and codegraph in project drawer"
\`\`\`

### 任务 5：记忆、Git 与底部引用栏

**文件：**
- 修改：\`tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx\`
- 修改：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.tsx\`
- 测试：\`tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

- [ ] **步骤 1：编写失败测试**

断言记忆标签搜索当前项目范围并可引用；Git 标签显示分支/变更/提交；无选中内容时引用按钮 disabled；点击引用调用 \`addPastedText\` 且不调用 \`send\`。

- [ ] **步骤 2：运行测试确认失败**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace/ProjectContextDrawer.test.tsx\`

预期：FAIL，记忆/Git 内容与引用栏尚未实现。

- [ ] **步骤 3：实现记忆和 Git 标签**

记忆使用现有 \`/v3/conversation/search\`、\`/v3/atomic/search\` 或当前项目已有记忆接口；Git 使用 \`useGitInfo(workspace)\`、\`useGitStore\` 和 \`pi.getGitDiff\`/\`pi.getGitLogGraph\` 的现有路径。标签组件向抽屉返回 \`{ text, source, label }\`；底栏只消费当前选中引用。

- [ ] **步骤 4：运行测试确认通过**

运行同上，预期记忆、Git 和引用行为测试 PASS。

- [ ] **步骤 5：提交**

\`\`\`bash
git add tauri-agent/src/features/chat/input/workspace/ProjectContextTabs.tsx tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.tsx tauri-agent/src/features/chat/input/workspace/ProjectContextDrawer.test.tsx
git commit -m "feat: add memory git tabs and project citations"
\`\`\`

### 任务 6：澄清 Agent 装备职责并回归 Pi 模型配置

**文件：**
- 修改：\`tauri-agent/src/features/tencentdb/AgentLoadout.tsx\`
- 修改：\`tauri-agent/src/features/tencentdb/AgentLoadout.test.tsx\`
- 检查：\`tauri-agent/src/features/settings/SettingsPanel.tsx\`、\`tauri-agent/src/features/settings/settingsSchema.ts\`、\`tauri-agent/src/features/chat/input/actions/ModelAction.tsx\`

- [ ] **步骤 1：编写失败测试**

更新测试以断言页面显示“知识注入规则”、包含 injection mode/priority 说明，并确认不存在 TencentDB LLM 配置字段或独立模型选择器。

- [ ] **步骤 2：运行测试确认失败**

运行：\`cd tauri-agent && pnpm vitest run src/features/tencentdb/AgentLoadout.test.tsx src/features/settings/SettingsPanel.test.tsx\`

预期：文案断言 FAIL。

- [ ] **步骤 3：实现最小文案与入口调整**

仅修改 AgentLoadout 的标题、描述、保存按钮和空状态提示；如果设置 schema 已存在历史 \`llmBaseUrl/llmModel\` 配置入口，移除 TencentDB 面板中的编辑项，但保留底层兼容字段读取，不删除用户现有配置文件。模型选择继续由 \`ModelAction\` 和 Pi provider list 提供。

- [ ] **步骤 4：运行测试确认通过**

运行：\`cd tauri-agent && pnpm vitest run src/features/tencentdb/AgentLoadout.test.tsx src/features/settings/SettingsPanel.test.tsx src/features/chat/input/actions/ModelThinkingAction.test.tsx\`

预期全部 PASS，且模型动作仍调用既有 \`pi.setModel\`。

- [ ] **步骤 5：提交**

\`\`\`bash
git add tauri-agent/src/features/tencentdb/AgentLoadout.tsx tauri-agent/src/features/tencentdb/AgentLoadout.test.tsx tauri-agent/src/features/settings/SettingsPanel.tsx tauri-agent/src/features/settings/settingsSchema.ts
git commit -m "feat: clarify agent loadout as knowledge injection"
\`\`\`

### 任务 7：完整验证与视觉回归

**文件：**
- 检查：任务 1-6 全部修改文件

- [ ] **步骤 1：运行定向测试**

运行：\`cd tauri-agent && pnpm vitest run src/features/chat/input/workspace src/features/tencentdb/AgentLoadout.test.tsx src/features/settings/SettingsPanel.test.tsx\`

预期：全部 PASS。

- [ ] **步骤 2：运行 TypeScript 与生产构建**

运行：\`cd tauri-agent && pnpm build\`

预期：TencentDB sidecar 校验、\`tsc\` 和 Vite build 均成功。

- [ ] **步骤 3：检查视觉与交互**

运行：\`cd tauri-agent && pnpm dev -- --host 127.0.0.1\`

用浏览器检查桌面和窄窗口：卡片在输入框外且与 WorkspaceBar 同层；抽屉从右侧滑入；抽屉打开不遮挡发送按钮；标签内容滚动独立；关闭后编辑器内容保持。

- [ ] **步骤 4：提交验证结果**

\`\`\`bash
git status --short
git diff --check
\`\`\`

预期无本计划引入的未提交错误、无空白错误；保留用户原有未相关修改，不执行 reset/checkout。

---

## 计划自检

- 规格覆盖：浮动卡片（任务 2）、右侧五标签抽屉（任务 3-5）、引用（任务 1/5）、Pi 模型统一与 Agent 装备说明（任务 6）、错误/空状态与 stale response（任务 2-3）、验收与回归（任务 7）。
- 占位符扫描：计划不包含 TODO、待定、TBD 或“适当处理”等空泛步骤；每个任务给出了文件、测试命令、预期结果和提交点。
- 类型一致性：引用统一使用现有 \`PastedText\`，抽屉作用域统一使用 \`workspace\`，知识数据统一使用 \`TencentdbKnowledgeAssets\`，Git 数据统一使用现有 \`useGitInfo/useGitStore\`。
