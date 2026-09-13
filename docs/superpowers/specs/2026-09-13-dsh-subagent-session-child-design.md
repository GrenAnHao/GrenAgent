# DSH 子代理第一期：真会话子代理（Session Child）

- 日期：2026-09-13
- 状态：第一期已落地
- 主题：对齐 DeepSeek Harness（DSH）子代理的「真 Session」语义；在 **sidecar + Electron** 内用进程内子会话替代默认子进程 JSONL，父模型只收最后一条助手正文，详情面板绑定子会话 JSONL（只读）。
- 关联：`extensions/multi-agent/`、`electron-agent/src/features/panels/SubAgentConversation.tsx`、`docs/superpowers/specs/2026-06-15-unified-subagent-system-design.md`（P5 embedded 备选，本期落地）。

---

## 1. 目标与分期

DSH 子代理是五层叠在一起；GrenAgent 不能一份规格盖全。本期只做 **规格 1**：

| 规格 | 对齐 DSH | 状态 |
|------|----------|------|
| 1. 真会话 one-shot | 子代理是 Session；`SubagentResult.output` = 最后非空 assistant；inherit 父模型；详情打开子会话 | **已落地** |
| 2. 可继续 + notice | Activation、inbox、`send_message`、settle notice | [规格已落盘](./2026-09-13-dsh-subagent-continuable-notice-design.md) |
| 3. 页头目录 | 谱系目录、token/耗时、只读 vs 可续聊 | [规格已落盘](./2026-09-13-dsh-subagent-header-catalog-design.md) |
| 4. fork | 种父会话已完成轮次 | [规格已落盘](./2026-09-13-dsh-subagent-fork-seed-design.md) |

**范围**：`extensions/multi-agent`（embedded runner + spawn 路由）+ `electron-agent`（详情绑定）。CLI / Tauri 继续走现有 `spawnPiAgent` 子进程路径。

**明确不做**：改工具名为 DSH `subagent`、默认后台 + 父会话 notice、Tauri UI、删掉已修好的子进程路径。

---

## 2. 推荐方案 A：sidecar 进程内子 Session，高危回退子进程

- **默认（Electron 主进程 sidecar）**：在 sidecar 内 `createAgentSessionFromServices` 为子代理建独立 `SessionManager` + JSONL，跑一轮 `prompt`，不另起 `pi` 进程。
- **安全**：子 Session `excludeTools` 强制去掉 `spawn_agent` / `explore_context`；`runInWorkspace({ origin: 'subagent' })` 标工具来源。
- **高危 / 非 Electron**：`profile.isolation === 'worktree'`（executor）、或无 `process.versions.electron` → 现有 `spawnPiAgent`（`extractFinalText` 规则不变）。
- **工具名**：仍叫 `spawn_agent`。

---

## 3. 权威结果（对齐 DSH `assistant-output`）

1. 子会话里最后一条**非空** assistant 消息正文  
2. 否则累积的助手流式正文（`text_delta`）  
3. 都没有 → 空；工具结果写明确失败 / `(no output)`  
4. **禁止**把 `session` 头或 raw JSONL 尾部当产出  

失败带 `stopReason`：`completed` | `aborted` | `error`。部分输出（超时等）单独附上，不算成功。

工具 `details` 至少：`{ agentId, sessionPath, stopReason }`；`content` 仅最终助手正文。

---

## 4. Sidecar 设计

### 4.1 模块

- `extensions/multi-agent/embedded-runner.ts` — 进程内 one-shot 子 Session（**不**堆进 `runner.ts`）
- `extensions/multi-agent/assistant-output.ts` — 从 `AgentMessage[]` / 流式 delta 抽最终正文
- `extensions/multi-agent/index.ts` — 路由 embedded vs subprocess；`details.sessionPath`

### 4.2 子 Session 生命周期

1. `SubAgentRegistry.genId()` → `sa-…`  
2. `SessionManager.create(cwd, undefined, { id, parentSession: parentPath })`  
3. Header / custom entry 记 `origin: subagent`、`parentSession`、模型 `provider/id`  
4. 模型：`显式 → named agent → profile → SUBAGENT_MODEL → ctx.model`（`pickSubagentModel`）  
5. `resolveCliModel` + `appendSystemPrompt`（named agent system）  
6. `bindExtensions({ mode: 'rpc' })` + `prompt(task)` + `waitForIdle`  
7. `dispose` 子 Session；**保留** JSONL 文件供 UI 绑定  

### 4.3 工具过滤

- 继承 profile `SAFETY_DENY_TOOLS`（经 ALS config）  
- 强制 `excludeTools`: `spawn_agent`, `explore_context`  
- named agent 的 `tools` allowlist → `createAgentSessionFromServices({ tools })`

---

## 5. Electron 详情

- `details.sessionPath` 存在 → 同一 workspace 的第二条只读绑定：种子消息经 IPC 读子会话 JSONL，流式事件按 `sessionPath` 灌进该绑定（`source: subagent`），不经 `transcriptTail`。  
- 无 `sessionPath`（旧卡片 / 子进程回退）→ 现有 JSONL `transcript` / registry 回放。  
- 本期不做页头目录、子会话输入框、侧边栏子会话列表。

---

## 6. 测试

- `assistant-output`：空 usage 消息跳过、delta 兜底、session 头不是产出  
- `embedded-runner`：mock `createAgentSessionFromServices` 路径；inherit 模型  
- `index`：`canUseEmbedded` 路由；`details.sessionPath`  
- Electron：`subagentUtils` / `SubAgentConversation` — 有 `sessionPath` 走会话读取、无 path 走旧回放  

---

## 7. 后续规格

实现顺序仍是 1 → 2 与 3 可并行（3 的可续聊编辑器依赖 2）→ 4。不要把四份合成一份计划。

- [规格 2：可续聊 + settle notice](./2026-09-13-dsh-subagent-continuable-notice-design.md)
- [规格 3：页头目录](./2026-09-13-dsh-subagent-header-catalog-design.md)
- [规格 4：fork 种子](./2026-09-13-dsh-subagent-fork-seed-design.md)
