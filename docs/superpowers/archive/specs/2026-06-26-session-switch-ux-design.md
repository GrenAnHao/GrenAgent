# 会话切换 UX 修复设计（加载延迟 / 删除回弹 / 缓存卡死）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待用户审查 → writing-plans
- 范围：修复 tauri-agent 桌面端「切会话/切项目慢、删除非即时、删后列表回弹、对话列表/消息缓存卡在已删会话」四组体感问题。**纯前端（`tauri-agent/src`）状态同步 + 缓存修复，零后端协议改动、零 Pi fork、不换会话存储格式。**
- 运行时基准：`@earendil-works/pi-coding-agent`（npm 包，仓库无 `pi/` fork）。多进程模型（每 workspace 一个 sidecar）**保持不变**——用户已确认接受多进程。
- 所属总盘：与零 fork 改造 6 子项目正交；本项是其落地后暴露的桌面集成层 UX 缺陷修复，全部落在第二层（前端编排）。

## 1. 背景与目标

用户诉求（原话归纳）：

1. 「加载到效率很低，切会话、切项目响应太慢」。
2. 「切会话、删除会话会回弹」。
3. 「删除会话非立即删除；删除后又加载列表，我又删一次」。
4. 「对话列表的缓存卡在已删除的会话上」。

四件本质是同一病根的不同侧面：**乐观更新与"重新拉取/TTL 缓存"之间的竞态**，叠加**跨项目切换不走消息缓存的串行加载链**。目标：在不改 Pi、不改 RPC 协议、不换存储的前提下，让切换即时、删除即时且不回弹、缓存不残留已删会话。

## 2. 现状核验（实地，带锚点）

### 2.1 加载：缓存秒显已实现，剩余缺口是"首次加载"与"命中缓存仍跑整轮后端对齐"

切换 effect **已经实现了缓存秒显**（实地核对，修正最初判断）：

- `tauri-agent/src/App.tsx:314-327` —— store 内存已加载目标会话（`getLoadedSessionPath() === target`）或正实时流式 → **整段跳过** openWorkspace/getMessages，仅后台 `refreshAllSessions`，切回即时。
- `tauri-agent/src/App.tsx:328-333` —— store 未加载但命中模块级 `sessionMessageCache` → `store.showCachedSession(target)` 先秒显 + `setWorkspaceReady(true)`，再落到下方完整后端流程对齐（`loadMessages` 签名比对，未变不重渲染）。
- `tauri-agent/src/App.tsx:454-463` —— 同项目切会话路径同样 `showCachedSession`。

因此"跨项目接消息缓存"基本已具备。**真实剩余缺口**：

1. **首次/未缓存会话**：无缓存可秒显（never-viewed 或被 LRU 30 驱逐），必走 `App.tsx:350-383` 串行链 `openWorkspace → refreshSessions → switchSession → getMessages`，主成本是冷 spawn（已被 `prewarm.ts`/`Sidebar.tsx:282` hover 预热部分消除）+ `getMessages` 的 jsonl 解析。
2. **命中缓存后仍跑整轮后端对齐**：即便 `App.tsx:331` 已秒显，下方仍 `openWorkspace`（会按 `last_session` 在后端白切一轮）+ `getMessages`。这既浪费，也是 §2.3 回弹的来源之一。
3. 结论：jsonl 在切换路径的代价只对"未缓存会话"显现；存储格式不是首要矛盾，**首要矛盾是删除竞态（§2.2/§2.3/§2.4），其次才是首屏未缓存会话的后端往返**。

### 2.2 全量会话拉取无"过期作废"，与乐观删除互相覆盖

- `tauri-agent/src/App.tsx:66-107` —— `refreshAllSessions`：`sessionCache.ts` 30s TTL 缓存 + inflight 去重，但**响应回来直接 `syncAllSessions(sessions)`，无单调 token 判定**。删除前发出的旧请求乱序晚到会把已删项写回 `allSessions`。
- `tauri-agent/src/App.tsx:472-489` —— `handleDeleteSession`：先 `hideDeletedSession(path)`（隐藏集，正确），但又裸 `setAllSessions(remaining)`；`invalidateAllSessionsCache()` 在 `await pi.deleteSession` **之后**才调——**拦不住已经在途的那个 `refreshAllSessions`**。
- `tauri-agent/src/App.tsx:342-401` 的 effect 在每次切换尾部还会 `void refreshAllSessions()`（:395，非 force），叠加上面这条 → 切换/删除交错时把旧列表灌回。
- 缓解现状（已有，但不够）：`tauri-agent/src/store/session.ts:71-79` 的 `syncAllSessions` 已**保留**隐藏集（注释明确点到"删除前旧请求乱序晚到写回"的风险）；`useConversations.ts:76` 与 `useProjectGroups.ts:109` 渲染前都过 `filterDeletedSessions`。所以**侧栏列表本身**对"已删 path 重现"有保护——回弹主要落在**选中态/内容区**与**缓存**。

### 2.3 删除/切换后的选中态会被自动重选抢走

- `tauri-agent/src/App.tsx:44-64` —— `refreshSessions`：`if (!active)` 时自动选 `openResult.sessionFile` 或 `sessions[0]`。删活跃会话后会 `setActiveSession('')`（`App.tsx:485`），随后 `refreshSessions`（:527）触发自动重选，与"删后想落到的目标会话"打架，表现为选中项跳一下。
- `tauri-agent/src/App.tsx:581-596` —— `handleDeleteConversation`：删的是活跃对话时，`next` 从**裸 `allSessions`**（:588）里挑，未过滤隐藏集 → 可能选中另一个"已隐藏但未落盘清理"的对话 → 触发 effect 打开一个已删 cwd → 闪/错。
- Rust 侧 `tauri-agent/src-tauri/src/commands/agent.rs` 的 `open_workspace` 会恢复该 workspace 的 `last_session`（`SwitchSession`）。跨项目切换时 effect 重跑 `openWorkspace`，后端按 `last_session` 白切一轮，与前端乐观 active 抢。

### 2.4 消息缓存不随删除清理 → 卡在已删会话

- `tauri-agent/src/lib/sessionMessageCache.ts` 只有 `getCachedSession`/`setCachedSession`，**无按 path 失效的导出**。删除会话不清它 → `showCachedSession(已删 path)` 仍命中旧内容；`sessionCache.ts` 的 allSessions 30s TTL 同理在删除后短时间内仍可能服务旧列表。这正是「缓存卡在已删会话」。

## 3. 组件设计

主线：**给所有"重拉"加单调代次（epoch）作废过期响应；删除/切换以隐藏集为唯一真相，不再裸改列表；缓存随删除即时失效；跨项目切换接消息缓存秒显。**

### 3.1 F1 单调代次作废过期重拉（回弹治根）

- 在 `sessionCache.ts` 增 `bumpSessionMutationEpoch()` / `getSessionMutationEpoch()`（模块级计数器）。
- `refreshAllSessions` 发请求前记录 `startedEpoch = getSessionMutationEpoch()`；响应回来时若 `startedEpoch !== getSessionMutationEpoch()`（期间发生过删除/新建/重命名 mutation），**丢弃该响应，不 `syncAllSessions`、不写缓存**。
- 每个 mutation（delete/new/rename/deleteConversation/removeProject）在乐观更新时 `bumpSessionMutationEpoch()` 并 `invalidateAllSessionsCache()`。
- 效果：删除后任何"删前/删中"发出的 `listAllSessions` 响应一律作废 → 不再"删后又加载把它弹回来"。

### 3.2 F2 删除以隐藏集为唯一真相

- `handleDeleteSession` / `handleDeleteConversation` 删除时**只**调隐藏集（`hideDeletedSession` / `hideDeletedConversation`）+ `removeOptimistic*` + `bumpSessionMutationEpoch` + `invalidateAllSessionsCache`，**移除裸 `setAllSessions(remaining)`**。渲染层 `filterDeletedSessions` 已保证即时移除，且不被任何重拉覆盖（F1 兜底）。
- `allSessions` 的真正更新只由"已作废过滤后的 `syncAllSessions`"完成，隐藏集在后台删除确认且重拉一致后自然 prune（保持现有"隐藏标记保留到运行结束"的保守策略，删除失败时 `unhide` 撤销）。

### 3.3 F3 加载提速（次要、measure-first）

缓存秒显已具备（§2.1），本项只补"剩余缺口"，且**先实测 `perf` 日志确认主成本再做**：

- **命中缓存后跳过冗余后端对齐**：当 `App.tsx:331` 已 `showCachedSession(target)` 秒显、且该 session 已是后端活跃会话（store 之前切过、`workspaceSessionPaths` 记录一致）时，跳过 effect 内的 `openWorkspace`+`getMessages` 整轮（避免后端按 `last_session` 白切 + 重复 getMessages）。判定条件保守：仅在"模块缓存命中且签名与后端一致"时跳过，否则照旧对齐（fail-safe）。
- **未缓存首屏**：确认 hover 预热覆盖到对话列表项（`Sidebar.tsx:282` 已对有 cwd 的条目 `prewarmWorkspace`；核对对话项是否带 cwd）。首屏 `getMessages` 的 jsonl 成本属固有，列入"增强（实测驱动）"，不在 MVP。
- 不改后端、不改 jsonl。

### 3.4 F4 选中态确定化

- `refreshSessions` 的自动重选仅在"调用方未显式指明 active 且当前 active 为空"时触发；删除/切换路径显式传入目标，禁止 `refreshSessions` 二次抢选。
- `handleDeleteConversation` 的 `next` 改为从 `filterDeletedSessions(mergeAllSessions(...), deletedSessionPaths)` + `deletedConversationCwds` 过滤后的列表里挑，不再用裸 `allSessions`。

### 3.5 F5 缓存随删除失效

- `sessionMessageCache.ts` 增 `invalidateCachedSession(path)`（删 `cache` 中该 path）。
- 删除会话/对话时调用它清掉对应 path（对话删除清其 cwd 下全部 session path）。
- `showCachedSession` 命中前先查隐藏集：已隐藏的 path 视为未命中（双保险）。

## 4. 数据流

```
切换(跨项目)：点击 → showCachedSession(path) 秒显(命中) / 骨架屏(未命中)
              → setActiveWorkspace → effect: openWorkspace → getMessages → loadMessages(签名比对) 对齐

删除：乐观 hideDeletedSession + invalidateCachedSession + bumpEpoch + invalidateAllSessionsCache
      → 列表即时移除(filterDeletedSessions) → 后台 deleteSession 完成 → refreshAllSessions(force, 新 epoch)
      → 任何旧 epoch 的在途响应被 F1 作废(不回弹)
```

## 5. 持久化 / 缓存

| 状态 | 位置 | 失效/作废时机 |
| --- | --- | --- |
| allSessions 列表缓存 | `sessionCache.ts`（30s TTL + inflight） | mutation 时 `invalidateAllSessionsCache` + epoch 作废过期响应 |
| 每会话消息缓存 | `sessionMessageCache.ts`（LRU 30） | 删除该 path 时 `invalidateCachedSession`；内容变化由签名比对 |
| 隐藏集（已删占位） | `store/session.ts`（`deletedSessionPaths`/`deletedConversationCwds`） | 删除成功保留至运行结束；失败 `unhide` 撤销 |
| 单调代次 epoch | `sessionCache.ts`（模块级计数） | 每次 mutation `bump` |

## 6. 错误处理 / 降级（全部 fail-soft）

- 后台 `deleteSession`/`deleteConversation` 失败 → `unhideDeletedSession`/`unhideDeletedConversation` 撤销隐藏 + 报错，列表恢复。
- `refreshAllSessions` 失败或过期 → 静默保留当前（隐藏集仍生效），不抛进 UI 主流程。
- `showCachedSession` 未命中 → 退回骨架屏 + `getMessages`，不影响正确性。
- epoch 作废纯属"丢弃过期数据"，最坏是少刷一次列表，下一次 mutation/TTL 到期自然补齐。

## 7. 模式适配

纯前端桌面（RPC 模式）问题，与 print/json 模式无关；不涉及 `ctx.ui.*` / `extension_ui` 子协议。后端 RPC 协议与命令集**零改动**（F4 不新增 RPC：仍用既有 `open_workspace`/`switch_session`/`delete_*`）。

## 8. 非目标（明确不做）

- **换会话存储（jsonl → SQLite）**：本期用消息缓存把"切换重读"成本吸收掉，多半不需要换。若做完 F1–F5 后实测仍证明单个大会话 jsonl 解析是瓶颈，再单列子项目评估（届时优先查 `createAgentSessionServices`/`SessionManager` 是否暴露存储注入口，能注入则仍零 fork）。
- **单进程多 runtime（D2）/ 改进程模型**：用户已接受多进程，本期不动。
- **新增后端 RPC / 改 Pi**：不做。F4 若需要"打开时直接定位目标 session、避免后端 last_session 白切"，优先用既有 `switch_session` 在 effect 内纠正，不加新命令。
- **物理改写磁盘会话历史**：不涉及。

## 9. 代码核对（实地锚点）

- 缓存秒显已实现：`App.tsx:314-327`（store 已加载则整段跳过）、`App.tsx:328-333`（模块缓存命中 `showCachedSession` 秒显）；同项目路径 `App.tsx:457`。
- 串行加载链（未缓存首屏走它）：`tauri-agent/src/App.tsx:350-383`。
- `workspaceReady` 生命周期：`stores/AgentStoreContext.tsx:37,48,52`（按 store `resident` 初始化/重置）。
- 重拉无 token + 删除竞态：`App.tsx:66-107`（refreshAllSessions）、`App.tsx:472-489`（裸 `setAllSessions` :481、`invalidate` 滞后 :489）、`App.tsx:395`（effect 尾部 refreshAllSessions）。
- 自动重选抢占：`App.tsx:44-64`（refreshSessions auto-select）、`App.tsx:581-596`（deleteConversation next 取裸 allSessions）。
- 隐藏集与渲染过滤（已有保护）：`store/session.ts:71-79,103-112`、`lib/mergeSessions.ts:21-24`、`useConversations.ts:76`、`useProjectGroups.ts:109`。
- 缓存：`lib/sessionCache.ts:3`（30s TTL，无 epoch）、`lib/sessionMessageCache.ts`（无 invalidate 导出）、`stores/agent.ts:43,186`（showCachedSession）。
- Rust：`tauri-agent/src-tauri/src/commands/agent.rs`（open_workspace 恢复 last_session + set_last_session）。

## 10. 测试策略

- 纯函数单测（vitest，`cd tauri-agent && npx vitest run <file>`）：
  - epoch 作废：`refreshAllSessions` 在 mutation 后丢弃过期响应（抽出可测的"应用响应"判定函数）。
  - `invalidateCachedSession` 删除命中、`getCachedSession` 随后 miss。
  - `filterDeletedSessions` + deletedConversationCwds 的 next 选择不含已删项。
- 组件/集成：`SessionItem`/Sidebar 删除即时移除、不回弹（沿用 `SessionItem.test.tsx` 风格，mock `pi.deleteSession` 延迟 + 并发 `refreshAllSessions`）。
- 手动冒烟：① 跨项目切换命中缓存秒显；② 连续删除多个会话无回弹、无需重删；③ 删除后切回该项目，列表与内容均不含已删会话。
- 类型：`npx tsc --noEmit`（tauri-agent）。

## 11. MVP 与增强分层

- **MVP（治本，按依赖序）**：F1 epoch 作废 → F2 删除唯一真相 + F5 缓存失效（一起，消"回弹/卡缓存/重删"）→ F4 选中态确定化。这三项直击用户最强烈的删除类痛点。
- **次要（measure-first）**：F3 加载提速——先看 `perf` 日志确认未缓存首屏的主成本（openWorkspace vs getMessages）再做"命中缓存跳冗余对齐"。
- **增强（实测驱动，单列）**：jsonl→SQLite 评估、给 `open_workspace` 传目标 session 以消除后端 `last_session` 白切（additive）、warm session 后端常驻多会话热缓存。
