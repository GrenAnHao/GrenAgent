# Pi 核心与供应商同步实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 升级 Pi 核心与扩展依赖，并同步系统供应商及模型同步来源。

**架构：** Pi `ModelRegistry` 提供内置模型，Tauri sidecar 返回可序列化模型列表；设置页仅对支持远程枚举的自定义供应商调用 `/models`。

**技术栈：** Node.js 22、npm、Bun、TypeScript、React、Vitest。

---

### 任务 1：升级 Pi 依赖

**文件：**
- 修改：`cli/package.json`、`cli/package-lock.json`
- 修改：`extensions/package.json`、`extensions/package-lock.json`、`extensions/bun.lock`

- [ ] **步骤 1：更新 Pi 包版本约束**

将 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` 从 `^0.84.2` 更新为 `^0.84.3`。

- [ ] **步骤 2：重新安装并生成锁文件**

运行 `npm install`（`cli`、`extensions`）和 `bun install`（`extensions`），确认锁文件解析到 `0.84.3`。

- [ ] **步骤 3：检查运行时导出**

运行 `node -e "import('@earendil-works/pi-coding-agent').then(m => console.log(['ModelRegistry','ModelRuntime'].map(k => [k, k in m])))"`。

### 任务 2：同步供应商元数据

**文件：**
- 修改：`tauri-agent/src/features/settings/providerPresets.ts`
- 测试：`tauri-agent/src/features/settings/providerPresets.test.ts`

- [ ] **步骤 1：补齐 Pi 内置供应商 ID 和能力标记**

新增 `baseten`、`github-copilot`、`openai-codex`、`qwen-token-plan`、`qwen-token-plan-cn`、`qwen-token-plan-individual`、`openrouter-images`、`radius`，并为 OAuth、图片、动态网关标注枚举能力。

- [ ] **步骤 2：添加目录覆盖测试**

测试供应商 ID 唯一、必需 ID 存在、特殊能力与 API 类型一致。

### 任务 3：分流模型同步

**文件：**
- 修改：`tauri-agent/src/features/settings/ModelSyncModal.tsx`
- 修改：`tauri-agent/src/lib/pi.ts`
- 测试：`tauri-agent/src/features/settings/ModelSyncModal.test.tsx`

- [ ] **步骤 1：增加内置模型查询入口**

调用现有 `listModelsGlobal`，按 provider 过滤并排除已添加模型。

- [ ] **步骤 2：对不可枚举供应商展示明确状态**

OAuth、图片和动态网关不调用 API Key 远程枚举，显示手动添加提示。

- [ ] **步骤 3：保留自定义供应商远程同步**

现有 `fetchProviderModels` 失败提示和批量选择行为保持不变。

### 任务 4：验证与收尾

**文件：**
- 无新增文件

- [ ] **步骤 1：运行 CLI 检查**

运行 `npm run typecheck`、`npm test`、`npm run build`。

- [ ] **步骤 2：运行扩展与前端测试**

运行 `npm test`（`extensions`）和 `bun run test`（`tauri-agent`，若环境允许）。

- [ ] **步骤 3：检查工作树和版本证据**

使用 `npm ls`、`git diff --check`、`git status --short`，记录阻塞项。
