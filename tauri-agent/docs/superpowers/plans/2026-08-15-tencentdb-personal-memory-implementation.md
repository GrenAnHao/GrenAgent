# TencentDB 个人记忆空间实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 \`superpowers:executing-plans\` 逐任务实现此计划。步骤使用复选框（\`- [ ]\`）语法跟踪进度。

**目标：** 用 TencentDB Gateway 替换本地长期记忆、知识检索、代码索引和 Skill 后端，并提供本机与个人远程两种模式。

**架构：** Tauri Rust 后端管理连接、凭据和本机服务；Pi extension 通过 TencentDB SDK 处理 L0--L3；Skill 缓存为 Pi 资源，Wiki/CodeGraph 经 MCP 可调用。旧后端在迁移验证前只读保留。

**技术栈：** Tauri 2/Rust、React 19/TypeScript、Pi extension API、TencentDB v3 SDK、MCP SDK、Vitest、cargo test。

**上游锁定：** 使用 `TencentCloud/TencentDB-Agent-Memory` 的 commit `97f94654280b2932c35ba4806a491999ed244cc9`（2026-08-15 核对，`feat/server_team`）。不能把 `MemoryPanel` 或 `MemoryProxy` 随客户端打包：个人模式只运行上游支持的 `MemoryCore` standalone Gateway 和 `MemoryKnowledge`。两者均要求 Node.js `>=22.16.0`；Docker 仅为上游提供的可选部署方式，不是本机模式依赖。

**本机运行时约束：** 构建脚本下载锁定 revision 的源码归档，在 Windows/macOS/Linux 各自构建后，连同匹配平台的 Node Runtime 置入 Tauri resource；不能在终端用户机器上执行 `npm install`。启动时 Rust 分配两个回环端口，向 MemoryCore 注入独占 `TDAI_DATA_DIR`、`TDAI_GATEWAY_CONFIG`、`TDAI_GATEWAY_API_KEY`、LLM 环境变量，向 MemoryKnowledge 注入独占数据目录、`LLM_MODE=custom` 和同一 LLM 环境变量。二者须分别通过 `/health` 后才标记本机模式 ready。Pi sidecar 仅在启动该会话时收到最小的 `TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_API_KEY`、身份坐标和知识服务地址；前端永不读取密钥。

---

## 基线

\`bun run test\` 在 Windows 隔离工作树中正确启动 Vitest，但五分钟未退出，已终止仅属于该工作树的测试进程。每项任务先执行定向测试，再执行构建；最终阶段单独定位全量 Vitest 未退出句柄。

## 文件结构

- \`tauri-agent/scripts/build-tencentdb-memory.mjs\`：准备随应用分发的 Node Runtime、MemoryCore 和 MemoryKnowledge MCP。
- \`tauri-agent/src-tauri/src/tencentdb/mod.rs\`：连接配置、Gateway 监督器和安全凭据边界。
- \`tauri-agent/src-tauri/src/commands/tencentdb.rs\`：脱敏状态、连接测试、服务控制、资产和迁移 command。
- \`extensions/tencentdb-memory/{client,context,capture,index}.ts\`：SDK、召回注入、增量 L0 写入与 Pi hook。
- \`extensions/tencentdb-skills/sync.ts\`：已装备 Skill 的原子缓存同步。
- \`extensions/mcp/config.ts\`：TencentDB MemoryKnowledge stdio MCP 配置。
- \`tauri-agent/src/features/tencentdb/*\`：连接设置、资产中心、装备与迁移向导。
- \`tauri-agent/src-tauri/src/commands/migration/tencentdb.rs\`：旧资产扫描、导入、验证和停用状态机。

### 任务 1：打包并监督本机 MemoryCore 与 MemoryKnowledge

**文件：**
- 创建：\`tauri-agent/scripts/build-tencentdb-memory.mjs\`
- 创建：\`tauri-agent/src-tauri/src/tencentdb/mod.rs\`
- 修改：\`tauri-agent/src-tauri/tauri.conf.json\`、\`tauri-agent/src-tauri/src/lib.rs\`
- 测试：\`tauri-agent/src-tauri/src/tencentdb/mod.rs\` 内 \`#[cfg(test)]\`

- [x] **步骤 1：编写失败测试**

\`\`\`rust
#[test]
fn remote_mode_never_spawns_a_child() {
    assert!(!MemoryMode::Remote.should_spawn_gateway());
}

#[test]
fn missing_bundled_entry_is_rejected() {
    assert!(BundledLayout::from_resource_dir(Path::new("C:/missing")).core_entry().is_err());
}
\`\`\`

- [x] **步骤 2：运行失败测试**

运行：\`cargo test -p tauri-agent tencentdb::tests -- --nocapture\`

预期：FAIL，\`MemoryMode\` 和 \`BundledLayout\` 未定义。

- [x] **步骤 3：实现最小监督器**

\`\`\`rust
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMode { Local, Remote }

impl MemoryMode {
    pub fn should_spawn_gateway(&self) -> bool { matches!(self, Self::Local) }
}

#[derive(Clone, Debug, Serialize)]
pub struct GatewayStatus {
    pub mode: MemoryMode,
    pub state: String,
    pub endpoint: String,
}
\`\`\`

脚本固定上述 TencentDB commit，构建并复制 Node Runtime、MemoryCore、MemoryKnowledge HTTP/MCP 入口与默认配置到 \`src-tauri/binaries/tencentdb-memory/<platform>/\`；不得复制数据目录、环境文件或密钥。Tauri \`bundle.resources\` 显式包含该目录。监督器只在 \`local\` 模式启动两个回环子进程，分配独立端口并轮询各自 \`/health\` 成功才返回 ready；应用退出时停止两个子进程。MemoryKnowledge 使用 \`LLM_MODE=custom\`，不依赖上游 Panel 回调链路。

- [x] **步骤 4：验证**

运行：\`cargo test -p tauri-agent tencentdb::tests -- --nocapture\`

预期：PASS。

运行：\`node scripts/build-tencentdb-memory.mjs --verify\`

预期：输出每个必需入口存在，且无凭据输出。

- [x] **步骤 5：提交**

\`\`\`powershell
git add tauri-agent/scripts/build-tencentdb-memory.mjs tauri-agent/src-tauri/tauri.conf.json tauri-agent/src-tauri/src/tencentdb/mod.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(memory): package local TencentDB gateway"
\`\`\`

### 任务 2：连接 command 与 Pi L0--L3 extension

**文件：**
- 创建：\`tauri-agent/src-tauri/src/commands/tencentdb.rs\`、\`tauri-agent/src/lib/tencentdb.ts\`
- 创建：\`extensions/tencentdb-memory/client.ts\`、\`context.ts\`、\`capture.ts\`、\`index.ts\`
- 创建：\`extensions/tencentdb-memory/context.test.ts\`、\`capture.test.ts\`
- 修改：\`tauri-agent/src-tauri/src/commands/mod.rs\`、\`tauri-agent/src-tauri/src/state/store.rs\`、\`extensions/index.ts\`

- [x] **步骤 1：编写失败测试**

\`\`\`ts
it('injects L3 into the system prompt and L1 as one bounded custom message', async () => {
  const result = await buildRecallInjection(client, '审查登录模块');
  expect(result.systemPrompt).toContain('<user-persona>');
  expect(result.message?.customType).toBe('tencentdb-memory');
});

it('captures only messages after the cursor', () => {
  expect(selectUncaptured(messages, 2).map((m) => m.content)).toEqual(['本轮问题', '本轮回答']);
});
\`\`\`

- [x] **步骤 2：运行失败测试**

运行：\`bunx vitest run ../extensions/tencentdb-memory/context.test.ts ../extensions/tencentdb-memory/capture.test.ts\`

预期：FAIL，helper 尚未定义。

- [x] **步骤 3：实现连接和 hook**

Rust command 只返回脱敏 DTO：

\`\`\`ts
export type TencentdbStatus = {
  mode: 'local' | 'remote';
  endpoint: string;
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  credentialConfigured: boolean;
  lastSuccessAt?: string;
};
\`\`\`

凭据仅由 Tauri 后端安全存储。SDK client 每个调用携带稳定 \`teamId\`、\`agentId\`、\`userId\`，写入以 \`ctx.sessionManager.getSessionId()\` 作为非空 \`sessionId\`。在 \`before_agent_start\` 并行调用 \`searchAtomic\`、\`readCore\`、\`listScenarios\`；在 \`agent_end\` 以游标加内容指纹后台调用 \`addConversation\`，不得上传完整历史。注册 \`tdai_memory_search\` 与 \`tdai_conversation_search\`。

- [x] **步骤 4：验证**

运行：\`bunx vitest run ../extensions/tencentdb-memory/context.test.ts ../extensions/tencentdb-memory/capture.test.ts\`

预期：PASS。

运行：\`npm --prefix ../cli run typecheck\`

预期：PASS，extension 已被注册。

- [x] **步骤 5：提交**

\`\`\`powershell
git add tauri-agent/src-tauri/src/commands/tencentdb.rs tauri-agent/src/lib/tencentdb.ts extensions/tencentdb-memory extensions/index.ts
git commit -m "feat(memory): add TencentDB connection and Pi memory extension"
\`\`\`

### 任务 3：同步 Skill、接入知识 MCP、构建原生个人界面

**文件：**
- 创建：\`extensions/tencentdb-skills/sync.ts\`、\`extensions/tencentdb-skills/sync.test.ts\`
- 修改：\`extensions/mcp/config.ts\`、\`extensions/mcp/config.test.ts\`
- 创建：\`tauri-agent/src/features/tencentdb/{ConnectionSettings,AssetCenter,AgentLoadout,tencentdbApi}.tsx\`
- 创建：\`tauri-agent/src/features/tencentdb/*.test.tsx\`
- 修改：\`tauri-agent/src/features/settings/settingsSchema.ts\`、\`SettingsPanel.tsx\`、\`src/lib/pi.ts\`、\`src/features/memory/MemoryPanel.tsx\`、\`src/features/knowledge/KnowledgePanel.tsx\`

- [x] **步骤 1：编写失败测试**

\`\`\`ts
it('writes versioned SKILL.md only under the managed root', async () => {
  await syncSkills(root, [{ id: 'review', version: 2, markdown: '# Review', resources: [] }]);
  expect(await readFile(join(root, 'review', 'SKILL.md'), 'utf8')).toContain('# Review');
});

it('skips codebase-memory when cutover sets CODE_INTEL off', () => {
  const servers = injectDefaultServers([], { TDAI_KNOWLEDGE_MCP: '1', CODE_INTEL: 'off' }, 'win32');
  expect(servers.some((s) => s.name === 'tencentdb-knowledge')).toBe(true);
});
\`\`\`

- [x] **步骤 2：运行失败测试**

运行：\`bunx vitest run ../extensions/tencentdb-skills/sync.test.ts ../extensions/mcp/config.test.ts\`

预期：FAIL，sync module 与 TencentDB MCP config 不存在。

- [x] **步骤 3：实现资产层和界面**

Skill 写入临时目录后验证每条资源路径，再原子替换 \`~/.pi/agent/tencentdb-skills/<agent-id>/\`；绝不覆盖用户 Skill，成功后增加 \`PI_RELOAD_REV\`。MCP 使用打包的 MemoryKnowledge stdio server；保留 codebase-memory 资源与默认能力，仅在 workspace cutover 设置 \`CODE_INTEL=off\` 时停止注入。

原生设置使用 segmented control 选择本机或远程、连接测试与本机服务控制。资产中心复用 \`ManagerLayout\` 展示 Chat Memory、Skill、Wiki、CodeGraph；装备页面只管理个人 Agent。替换旧 MemoryPanel 和 KnowledgePanel 的 \`/memory\`、\`/kb\` 调用，所有 loading、empty、failure、sync 状态固定布局。

- [x] **步骤 4：验证**

运行：\`bunx vitest run ../extensions/tencentdb-skills/sync.test.ts ../extensions/mcp/config.test.ts src/features/tencentdb\`

预期：PASS，路径逃逸被拒绝，cutover workspace 不再注入旧 codebase-memory。

运行：\`bun run build\`

预期：PASS。

- [x] **步骤 5：提交**

\`\`\`powershell
git add extensions/tencentdb-skills extensions/mcp tauri-agent/src/features/tencentdb tauri-agent/src/features/settings tauri-agent/src/features/memory tauri-agent/src/features/knowledge tauri-agent/src/lib/pi.ts
git commit -m "feat(memory): add TencentDB assets and native personal center"
\`\`\`

### 任务 4：迁移、验证和旧后端停用

**文件：**
- 创建：\`tauri-agent/src-tauri/src/commands/migration/tencentdb.rs\`
- 创建：\`tauri-agent/src-tauri/src/commands/migration/tencentdb_test.rs\`
- 创建：\`tauri-agent/src/features/tencentdb/MigrationWizard.tsx\`、\`MigrationWizard.test.tsx\`
- 修改：\`extensions/long-term-memory/index.ts\`、\`extensions/knowledge-rag/index.ts\`、\`extensions/mcp/config.ts\`
- 修改：\`tauri-agent/src-tauri/src/commands/{agent,tencentdb}.rs\`、\`tauri-agent/src/lib/tencentdb.ts\`

- [x] **步骤 1：编写失败测试**

\`\`\`rust
#[test]
fn missing_original_document_requires_manual_migration() {
    let report = scan_legacy_sources(&fixture_with_missing_source()).unwrap();
    assert_eq!(report.items[0].state, MigrationState::Manual);
}

#[test]
fn legacy_extensions_remain_enabled_before_verification() {
    assert!(cutover_plan(false).keep_legacy_extensions());
}
\`\`\`

- [x] **步骤 2：运行失败测试**

运行：\`cargo test -p tauri-agent migration::tencentdb -- --nocapture\`

预期：FAIL，scan 和 cutover state machine 不存在。

- [x] **步骤 3：实现状态机与可回滚停用**

实现 \`scan -> preview -> execute -> verify -> archived\`，每批记录 source ID、target ID、计数、错误与可重试标志。导入 Pi JSONL L0 和本地 \`SKILL.md\`，从原始文档重建 Wiki、从 Git remote 重建 CodeGraph。TencentDB 公共 \`atomic/update\` 只能更新已有 L1，不能创建旧 SQLite 中的 L1，因此该来源必须显示为 \`manual\`，不得伪装为导入成功；缺失原始来源同样产生 \`manual\` 项。

人工项通过 \`external_completed\` 或 \`explicit_waived\` 显式处置，要求非空备注并写入服务端时间。处置命令绑定 workspace、run ID 与 source ID；相同请求幂等，冲突覆盖被拒绝。向导选择以 \`workspace + runId\` 保存到本机，优先于服务端上次执行时的 \`selectedIds\`。

只有远端计数、每个迁移目标的真实内容抽样、Gateway/Knowledge health、每个 Wiki/CodeGraph 的构建与内容状态、L3 非空读取和当前 workspace 的真实 Pi hook 探针全部通过后，才允许归档。Pi 探针在临时 session 中发送唯一 nonce Prompt，验证 \`before_agent_start\` 产生的隐藏消息，并在 \`before_provider_request\` 中止外部模型请求；无可用模型/凭据、sidecar 忙碌、超时或 nonce 不匹配都保持失败。归档不删除旧 extensions、旧 command/UI、资源或数据，而是写入 workspace 独立的 cutover marker，并通过环境变量停用 \`long-term-memory\`、\`knowledge-rag\` 和 \`codebase-memory\`；旧数据保持只读可回滚，\`session-memory\` 永久保留。

Gateway、Knowledge 和本机运行时 health 请求均设置有限超时。迁移状态文件只有 \`NotFound\` 返回空状态；损坏 JSON、权限或其他 I/O 错误直接返回前端。

- [x] **步骤 4：验证**

运行：\`cargo test -p tauri-agent migration::tencentdb -- --nocapture\`

预期：PASS，未验证时旧链路继续启用；归档后仅运行时停用，不物理删除。

运行：\`bunx vitest run src/features/tencentdb/MigrationWizard.test.tsx ../extensions/tencentdb-memory ../extensions/tencentdb-skills\`

预期：PASS。

运行：\`bun run build\`

预期：PASS。

- [x] **步骤 5：提交**

\`\`\`powershell
git add tauri-agent/src-tauri/src/commands/migration tauri-agent/src-tauri/src/commands/agent.rs tauri-agent/src-tauri/src/commands/tencentdb.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs tauri-agent/src/features/tencentdb tauri-agent/src/lib/tencentdb.ts extensions/long-term-memory/index.ts extensions/knowledge-rag/index.ts extensions/mcp/config.ts
git commit -m "feat(memory): migrate to TencentDB with reversible cutover"
\`\`\`

## 规格覆盖自检

- 本机/远程 Gateway 和凭据边界：任务 1、2。
- L0--L3 召回与增量写入：任务 2。
- Skill、Wiki、CodeGraph、Agent 装备：任务 3。
- 原生个人界面：任务 3。
- 迁移、验证后停用和保留 session-memory：任务 4。
- 未来团队兼容的稳定身份：任务 2、3。
