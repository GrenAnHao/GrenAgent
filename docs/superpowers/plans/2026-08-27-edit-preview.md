# Edit 预览改进实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 edit 工具展示修改点上下文、可滚动代码、文件名和语言高亮，并清晰呈现空替换错误。

**架构：** 在现有 `ToolExecution` 中增加 edit 专用预览模型和组件。模型从 diff 或 old/new 文本生成带行号的上下文行；组件使用单个滚动高亮窗口，默认上下文视图并可切换完整内容。后端 edit 执行逻辑保持不变。

**技术栈：** React 19、TypeScript、`@lobehub/ui` Highlighter、antd-style、Vitest、Testing Library。

---

## 文件清单

- 修改：`tauri-agent/src/features/tools/ToolExecution.tsx`，接入 edit 预览组件和文件名展示。
- 创建：`tauri-agent/src/features/tools/EditPreview.tsx`，解析 diff/old-new 文本、计算上下文窗口、渲染滚动代码。
- 修改：`tauri-agent/src/features/tools/cardStyles.ts`，添加 edit 预览的滚动容器、行号和状态样式。
- 创建：`tauri-agent/src/features/tools/EditPreview.test.tsx`，覆盖上下文、路径、语言和空替换行为。

### 任务 1：编辑预览模型与失败测试

**文件：**
- 创建：`tauri-agent/src/features/tools/EditPreview.tsx`
- 创建：`tauri-agent/src/features/tools/EditPreview.test.tsx`

- [ ] **步骤 1：编写失败测试**

测试构造带 12 行上下文的 TypeScript diff，断言渲染结果包含修改点前后窗口、行号、`GeminiProvider.ts`，并且不会展示绝对路径；测试传入 `oldText === newText` 时显示原始错误文本。

- [ ] **步骤 2：运行测试确认失败**

运行：`bun --cwd tauri-agent test EditPreview.test.tsx`

预期：FAIL，模块尚未导出 `EditPreview`。

- [ ] **步骤 3：实现最小模型和组件**

实现 `EditPreviewProps`：`path`, `diff`, `oldText`, `newText`, `resultText`, `isError`。按路径 basename 展示文件名；优先解析 `diff`，没有 diff 时把 old/new 作为增删行；为修改行计算前后 5 行窗口；使用 `langByPath(path)` 选择高亮语言；代码区设置单一 `max-height` 滚动容器，并提供完整/上下文切换。

- [ ] **步骤 4：运行测试确认通过**

运行：`bun --cwd tauri-agent test EditPreview.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

运行：`git add tauri-agent/src/features/tools/EditPreview.tsx tauri-agent/src/features/tools/EditPreview.test.tsx && git commit -m "feat: add contextual edit preview"`

### 任务 2：接入工具详情和样式

**文件：**
- 修改：`tauri-agent/src/features/tools/ToolExecution.tsx`
- 修改：`tauri-agent/src/features/tools/cardStyles.ts`

- [ ] **步骤 1：替换 edit 分支**

在 `ToolDetail` 的 edit 分支中移除两个固定 160px 高亮框，改为传入 `path`, `diff`, `oldText`, `newText`, `text`, `isError` 的 `EditPreview`。其他工具分支保持不变。

- [ ] **步骤 2：调整标题路径摘要**

为 edit/search_replace/str_replace 的标题参数使用 basename；完整路径通过 `data-tooltip` 或 aria-label 保留。新增 `fileNameFromPath` 纯函数并补充其单元测试。

- [ ] **步骤 3：补充滚动条和行样式**

在 `cardStyles.ts` 中添加透明轨道、悬停显示的细滚动条样式，以及代码行/行号/增删标记样式；仅应用于 edit 预览，不改变 `CodeSurface` 和其他工具。

- [ ] **步骤 4：运行相关测试**

运行：`bun --cwd tauri-agent test ToolExecution.test.tsx EditPreview.test.tsx toolUtils.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

运行：`git add tauri-agent/src/features/tools/ToolExecution.tsx tauri-agent/src/features/tools/cardStyles.ts tauri-agent/src/features/tools/EditPreview.tsx tauri-agent/src/features/tools/EditPreview.test.tsx && git commit -m "feat: integrate edit preview into tool cards"`

### 任务 3：构建验证

**文件：** 无新增文件。

- [ ] **步骤 1：运行完整测试**

运行：`bun --cwd tauri-agent test`

预期：所有测试通过。

- [ ] **步骤 2：运行生产构建**

运行：`bun --cwd tauri-agent run build`

预期：TypeScript 检查和 Vite 构建成功。

- [ ] **步骤 3：检查工作区差异**

运行：`git status --short` 和 `git diff HEAD~2..HEAD --stat`

预期：只有本计划列出的文件发生变更。

- [ ] **步骤 4：Commit（如验证产生必要修正）**

若验证发现类型或测试问题，修正后运行：`git add tauri-agent/src/features/tools && git commit -m "fix: verify edit preview integration"`。
