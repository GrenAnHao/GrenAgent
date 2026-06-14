# MCP 添加改造设计规格 — 模态框（快速配置 / JSON 导入）+ 卡片增删改启停

> **面向 AI 代理：** 这是设计规格（spec）。下一步用 `superpowers:writing-plans` 产出实现计划，再用 `superpowers:executing-plans` 内联执行（本仓库**禁止子代理**）。
>
> 配套计划：`docs/superpowers/plans/2026-06-15-mcp-add-modal-plan.md`（待 writing-plans 阶段产出）。

**目标：** 重做 `tauri-agent` 扩展页「插件(MCP)」区：移除直接编辑 `MCP_SERVERS` JSON 的 textarea，改为通过「添加 MCP」模态框（两 tab：快速配置表单 / JSON 批量导入）增配；server 卡片支持启停、编辑、删除。布局参考 lobehub `PluginDevModal/MCPManifestForm`，图标统一用 lucide（经 `@lobehub/ui` 的 `Icon`），全程无 emoji。

**架构原则：** 纯前端改造，**不改 Rust/Tauri 后端**，**不新增 IPC**。所有增删改启停最终都落到两个 settings 字符串（`MCP_SERVERS` / `MCP_SERVERS_DISABLED`）的读写，复用既有 `useSettingsForm`（`persist` 静默存盘 + `save` 存盘并重启）。

**技术栈：** React 19 + TypeScript + `@lobehub/ui` 5.x + antd 6.x + antd-style（`createStaticStyles` + `cssVar`）+ lucide-react + vitest（jsdom）。

---

## 1. 背景与动机

### 1.1 现状

`tauri-agent/src/features/extensions/ExtensionsPanel.tsx` 的「插件」tab 当前用一个 `<textarea>` 让用户直接编辑 `MCP_SERVERS` 的 JSON。问题：

- 手写 JSON 易错（括号、转义、字段名）；无校验、无引导。
- server 卡片只读：能看状态点，但不能启停 / 编辑 / 删除。
- 与 lobehub 等成熟产品的「表单 + 一键导入」体验差距大。

### 1.2 后端能力边界（已核实 `src/lib/pi.ts`）

- 仅有 `getSettings()` / `setSettings(map)`；**无** MCP 测试连接 IPC。
- `MCP_SERVERS` 由 Rust 端在 sidecar spawn 时注入 env，改动必须重启 sidecar 才生效。
- 实时连接状态来自 `useMcpStatusStore`（sidecar mcp extension 经 `setStatus` 推送：`connecting | connected | failed` + `tools` 数）。

**推论：** 不做「测试连接」（无对应 IPC）；连接状态只能在「重启生效」后由卡片状态点反映。

### 1.3 参考实现（lobehub）

`lobehub/src/features/PluginDevModal/MCPManifestForm/`：

- `QuickImportSection.tsx`：全宽虚线按钮 → 展开 TextArea 粘贴 `{mcpServers:{...}}` → 解析回填。
- `MCPTypeSelect.tsx`：两张卡片选 HTTP / STDIO（图标 + 描述 + 选中打勾），用 `createStaticStyles + cssVar`。
- `index.tsx`：vertical Form，字段 identifier / command / args / env（STDIO）或 url / auth / headers（HTTP）。

本设计借鉴其布局与字段，但简化（去掉 OAuth、测试连接）并适配 tauri-agent 的双 setting 存储模型。

---

## 2. 范围（已与用户确认）

| 项 | 决定 |
|----|------|
| 整体结构 | 单「添加 MCP」模态框 + 两 tab：**快速配置** / **JSON 导入** |
| 快速配置类型 | **STDIO** 与 **REMOTE**（HTTP/SSE），卡片选择 |
| STDIO 字段 | MCP 名称、命令 command、参数 args、环境变量 env |
| REMOTE 字段 | MCP 名称、URL、鉴权（无 / Bearer Token）、请求头 Headers |
| JSON 导入 | 粘贴标准 `{mcpServers:{...}}`，支持一次多个（批量），快速导入合并于此 tab |
| 卡片操作 | **启停**（开关）、**编辑**（回填同款表单）、**删除**（二次确认） |
| 生效 | 改动自动存盘（`persist`）+ 顶部「重启生效」按钮（`save`，沿用现有机制） |
| 图标 | lucide，经 `@lobehub/ui` 的 `Icon`；无 emoji |

**非目标（YAGNI）：** 测试连接、OAuth2、server 拖拽排序、远程鉴权的 client id/secret 流程。

---

## 3. 数据模型与存储

两个 settings 字符串，均为标准 `{ "mcpServers": { <name>: <config> } }` 结构：

- **`MCP_SERVERS`** — 启用集。pi 实际注入的就是它。
- **`MCP_SERVERS_DISABLED`** — 禁用集。保留完整配置但不注入。

单个 server config（联合类型）：

```jsonc
// STDIO
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
// REMOTE
{ "url": "https://...", "headers": { "Authorization": "Bearer ...", "X-Api-Key": "..." } }
```

> 鉴权落地：REMOTE 的「Bearer Token」在序列化时写入 `headers.Authorization = "Bearer <token>"`，不引入后端不认识的自定义字段。UI 回填时反向识别 `headers.Authorization` 还原为 Bearer 选项。

**操作 → 存储映射：**

| 操作 | 存储变化 |
|------|----------|
| 添加（表单/JSON） | 合并进 `MCP_SERVERS` |
| 编辑 | 覆盖 `MCP_SERVERS`（或 `MCP_SERVERS_DISABLED`，取决于该 server 当前在哪个集合）里对应项 |
| 启用 | 把 server 从 `MCP_SERVERS_DISABLED` 移到 `MCP_SERVERS` |
| 禁用 | 把 server 从 `MCP_SERVERS` 移到 `MCP_SERVERS_DISABLED` |
| 删除 | 从所在集合移除 |

每次写入 → `setValue` 改对应 setting → `markChanged()` → 防抖 `persist()` 静默存盘 + 顶部「重启生效」按钮出现。

---

## 4. 组件拆分

落点目录：`tauri-agent/src/features/extensions/`

- **`ExtensionsPanel.tsx`（改）** — 插件 tab：渲染 server 卡片列表（启用 + 禁用）+ 顶部「添加 MCP」按钮；持有「添加/编辑模态框」开关状态；技能 tab 不变。移除 `MCP_SERVERS` textarea。
- **`McpServerCard.tsx`（新）** — 单卡片：状态点 + 名称 + transport pill + 状态文字 + 操作区（启停 `Switch`、编辑 `PencilLine`、删除 `Trash2`）。禁用卡片灰显。
- **`AddMcpModal.tsx`（新）** — `@lobehub/ui` 的 `Modal`；内含两 tab（`Segmented` 或自定义 tab）：
  - **快速配置**：`McpTypeSelect`（STDIO/REMOTE 卡片）+ 按类型渲染字段 + 校验 + 提交。
  - **JSON 导入**：`TextArea` + 「导入 N 个」；解析 `{mcpServers:{...}}`，批量合并。
  - 编辑模式：传入 server 名 + 现有 config 回填，标题与按钮文案切换为「编辑」。
- **`McpTypeSelect.tsx`（新）** — 两张类型卡片（对齐 lobehub `MCPTypeSelect`，图标 `Terminal` / `Router`）。
- **`mcpConfig.ts`（新，纯函数 + 单测）** — 解析与序列化：
  - `parseMcpServers(json) -> {name, config}[]`（含 transport 推导，迁移现有逻辑）
  - `serializeForm(formValues) -> {name, config}`（表单 → config，含 Bearer→headers）
  - `configToForm(name, config) -> formValues`（config → 表单回填，含 headers.Authorization→Bearer）
  - `parseMcpImport(text) -> {ok, servers} | {error}`（解析粘贴 JSON，支持多个）
  - `mergeServers / removeServer / moveServer`（增删 + 启停集合迁移，返回新的两个 JSON 字符串）
- 复用：`KeyValueEditor`（env / headers；tauri-agent 若无则新增一个轻量版）。

> 单文件控制在 ~300 行内；`AddMcpModal` 若过大，按 tab 再拆 `McpFormTab` / `McpJsonImportTab`。

---

## 5. 数据流

**加载：** `useSettingsForm` → 解析 `MCP_SERVERS`（启用）与 `MCP_SERVERS_DISABLED`（禁用）为统一列表（带 `enabled` 标记）→ 与 `useMcpStatusStore` 按名 join 得到实时状态 → 渲染卡片。

**添加（快速配置）：** 选类型 → 填字段 → 校验 → `serializeForm` → `mergeServers` 写回 `MCP_SERVERS` → `markChanged` → 自动存盘 → 关闭模态框。

**添加（JSON 导入）：** 粘贴 → `parseMcpImport` → 校验/冲突处理 → 批量 `mergeServers` → 写回 → 关闭。

**编辑：** 卡片点 `PencilLine` → 打开模态框（`configToForm` 回填）→ 保存 → 覆盖对应集合中的项。

**启停：** 卡片 `Switch` → `moveServer`（在两个集合间迁移）→ 写回两个 setting → markChanged。

**删除：** 卡片 `Trash2` → 二次确认（`@lobehub/ui` 的 confirm/`Modal`）→ `removeServer` → 写回。

---

## 6. 校验与错误处理

- **MCP 名称：** 必填、唯一（跨启用+禁用集合）、`^[\w-]+$`。
- **STDIO：** command 必填。
- **REMOTE：** url 必填且 `new URL(value)` 合法。
- **JSON 导入：** 解析失败 → 顶部 Alert 提示行号/原因；名称与现有冲突 → 提示并跳过冲突项（或覆盖，二选一，计划阶段定，默认「跳过并提示」）。
- **删除：** 二次确认，避免误删。
- 所有提交失败（存盘异常）走 `useSettingsForm.error` → 现有 errorBar 展示。

---

## 7. 图标映射（lucide via `@lobehub/ui` `Icon`）

| 用途 | lucide |
|------|--------|
| 插件 / MCP | `Boxes` |
| 技能 | `Sparkles` |
| 添加 | `Plus` |
| STDIO 类型 | `Terminal` |
| REMOTE 类型 | `Router` |
| 编辑 / 删除 | `PencilLine` / `Trash2` |
| 选中 / 关闭 | `Check` / `X` |
| JSON 导入 | `Download` |
| 重启生效 | `RotateCw` |
| 添加行（env/headers） | `Plus` / `Minus` |

---

## 8. 测试（vitest + @testing-library/react）

**`mcpConfig.test.ts`（纯函数，重点）：**
- `parseMcpServers`：标准 `mcpServers` 包裹格式 + 裸 map；stdio/sse 推导。
- `serializeForm` / `configToForm`：STDIO 往返；REMOTE 含 Bearer↔headers.Authorization 往返；headers 保留。
- `parseMcpImport`：单个 / 多个 / 非法 JSON / 缺字段。
- `mergeServers` / `removeServer` / `moveServer`：增、删、启停集合迁移；名称冲突。

**`ExtensionsPanel.test.tsx`（更新）：**
- 列表渲染启用 + 禁用卡片；禁用卡片标记。
- 点「添加 MCP」打开模态框。
- 启停开关调用 moveServer 并更新两个 setting。
- 删除二次确认后移除。
- 「重启生效」按钮在改动后出现、点击触发 `save`（已有用例延续）。

**`AddMcpModal.test.tsx`（新）：**
- tab 切换；STDIO/REMOTE 类型切换字段。
- 表单校验（名称空/重复、url 非法、command 空）。
- 提交拼出正确 config 并合并。
- JSON 导入：批量解析 + 冲突处理。

---

## 9. 验收标准

1. 插件 tab 不再有可直接编辑的 `MCP_SERVERS` textarea。
2. 「添加 MCP」模态框可用：快速配置（STDIO/REMOTE）与 JSON 批量导入都能成功新增。
3. 卡片可启停 / 编辑 / 删除，且正确反映到 `MCP_SERVERS` / `MCP_SERVERS_DISABLED`。
4. 全程 lucide 图标，无 emoji。
5. 改动自动存盘 +「重启生效」按钮生效；重启后状态点正确。
6. `bun run`（vitest）相关用例通过；`tsc --noEmit` 0 错误；无新增 lint。

---

## 10. 风险与取舍

- **禁用集语义：** pi 只读 `MCP_SERVERS`，禁用集是纯前端约定；若用户在外部手改设置文件，禁用集可能与实际不同步——可接受（UI 以两个 setting 为准）。
- **鉴权简化：** 仅 None / Bearer（落 headers）；更复杂鉴权请走 JSON 导入手填 headers。
- **无测试连接：** 受后端能力限制；通过「重启生效 + 状态点」闭环替代。
