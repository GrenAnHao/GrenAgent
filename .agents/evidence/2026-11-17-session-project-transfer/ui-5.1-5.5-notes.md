# 2026-11-17 session-project-transfer — 渲染层（5.1–5.5）

实现范围：`src/features/sessions/*`（菜单两种行、`SessionProjectTransferDialog`、actions/草稿/列表投影）、
`src/App.tsx`、`src/store` + 草稿 / 停靠 / 会话缓存相关文件与测试、新 `ui-harness` 场景与 probe、
`docs/session-project-transfer.md`。

## 改动清单

| 文件 | 作用 |
|---|---|
| `src/features/sessions/useSessionMenu.ts`、`SessionItem.tsx`、`ConversationRow.tsx`、`GroupSessionRow.tsx`、`Sidebar.tsx` | 两种会话行共用「移动到项目…」（在「重新生成标题」之后）；已归档行不传入，因此没有入口 |
| `src/features/sessions/SessionProjectTransferDialog.tsx` | typed `pi.sessionProjectTransfer.preview/commit/retryOpen`；已有项目列表 + `pickDirectory` 本地目录；源 / 目标完整路径；「不搬代码文件」；族摘要；权限回退说明；busy / stale / no-op；`committed-needs-open` 重开；`recovery-required` 只读提示；提交中关闭不当作回滚 |
| `src/features/sessions/sessionProjectTransferActions.ts` | 成功后：单条 cwd 投影（不重复显示）、清源 `workspaceSessionPaths`、bump 代次 + 失效缓存、登记目标项目、`markTransferOpen`、只清源 store 中正好加载这份会话且无实时活动的画面；`restoreTransferProjection` 供提交前失败回滚 |
| `src/features/sessions/sessionProjectTransferScope.ts` | 目标候选、`relocateSession`、跨项目「这一次是迁移打开」标记（consume 一次）、busy / stale / family 文案 |
| `src/features/sessions/sessionProjectTransferDraft.ts` | composer JSON 文件 / 目录标签相对 → 源项目绝对；纯文本回退串同步；胶囊参数 / 正文不动；按 sessionPath 一次性交接（不碰其他草稿）；已挂载编辑器走订阅就地转换 |
| `src/features/sessions/sessionProjectTransferStore.ts` | 弹窗目标单例 |
| `src/App.tsx` | 接入弹窗与 `handleTransferOpened`；`refreshSessions` 也按逻辑代次丢弃旧响应；迁移打开跳过 `resetWorkspaceTabs`；`getMessages` 透传 `leafId` / `transfer` |
| `src/stores/chatDraftStore.ts` | `handoff(sessionPath, sourceWorkspace)`：转换本会话草稿并写回存档 |
| `src/features/chat/ChatInput.tsx` | 恢复草稿时 `applyQueuedDraftHandoff`；已挂载编辑器改为订阅 `subscribeDraftHandoff` 后就地转换（不丢胶囊 / 图片 / 其他草稿） |
| `src/stores/dockStore.ts` | `FilePayload.sessionWorkspace`（旧标签固定原根）；`TerminalPayload.originWorkspace`（旧 shell 不伪装成目标终端） |
| `src/features/dock/openLauncherTab.ts`、`TerminalBody.tsx` | 文件 tab 记所属项目根；终端用自身 `originWorkspace` 启动并记住它，目标项目另开新终端 |
| `src/stores/sessionSnapshot.ts`、`src/stores/sessionTransferHistoryMerge.ts`、`src/lib/sessionTransferOrigin.ts`、`src/stores/agent.ts` | ui-history 比 backend 长时按 entryId/toolCallId/时间最近邻贴回 `sourceCwd` / `sourceRefs`；已有来源优先；未映射旧行用 `transfer.fromWorkspace` 或本次运行期来源兜底；补过来源的 ui-history 在正常加载 / 同签名提前 return / 后台 backfill 三条路径写回；`leafId === null` 为空根，不把旧 ui-history 当当前 leaf、也不写空数组覆盖长期 ui-history |
| `ui-harness/scenarios/session-project-transfer.tsx`、`ui-harness/probes/session-project-transfer.mjs` | 新场景，见下 |
| `docs/session-project-transfer.md` | 用户操作与限制文档（含权限回退、项目用量分组、已提交待打开） |
| `AGENTS.md` | 场景清单新增本场景 |

## 验证（实跑）

命令与结果（2026-11-17，本机 Windows）：

```bash
cd electron-agent
npm run ui:check -- session-project-transfer
# 通过：session-project-transfer（29.3s）。只跑了 1/56 个场景，其余 55 个没指定，未运行
# ── 93 passed, 0 failed
```

证据：`.agents/evidence/2026-11-17-session-project-transfer/`

- `ui-check-session-project-transfer.log`：完整 PASS 列表（93 条）。
- `session-project-transfer-initial.png`、`session-project-transfer-dialog-open.png`、
  `session-project-transfer-after-move.png`、`session-project-transfer-history-link-missing-source.png`、
  `session-project-transfer-dialog-light.png`、`session-project-transfer-dialog-narrow-light.png`。

定向单测（同一工作树）：

```bash
npx vitest run --project renderer \
  src/features/sessions/sessionProjectTransferScope.test.ts \
  src/features/sessions/sessionProjectTransferDraft.test.ts \
  src/features/sessions/sessionProjectTransferActions.test.ts \
  src/features/sessions/sessionProjectTransferRace.test.ts \
  src/stores/sessionTransferHistoryMerge.test.ts \
  src/features/sessions/sessionMenu.test.ts src/features/sessions/SessionItem.test.tsx \
  src/features/sessions/GroupSessionRow.test.tsx src/features/sessions/ConversationRow.test.tsx \
  src/stores/dockStore.test.ts src/features/dock/openLauncherTab.test.ts \
  src/stores/chatDraftStore.test.ts src/features/chat/ChatInput.test.tsx \
  src/stores/agent.test.ts src/stores/todoConsistency.test.ts
# Test Files 15 passed (15) / Tests 197 passed (197)
```

新增覆盖点：

- 目标候选排除源项目 / works 对话目录 / 已归档；`relocateSession` 不重复、保留 id / 标题。
- 草稿：相对文件标签 → 源项目绝对；胶囊参数与 label 不动；绝对路径与无引用草稿不改；一次交接、不串写其他草稿。
- 移动 action：只改这一条、清源绑定、登记目标、置顶保留；只清正好加载这份会话且无实时活动的源 store；回滚只动这一条。
- 列表代次：提交前发出的旧响应作废，会话不放回源项目、不显示两份。
- 历史来源：ui-history 比 backend 长 / 同签名重挂 / 往返迁移保留旧来源 / 旧辅助条目按迁移来源兜底 / `leafId === null` 空根不被旧 ui-history 冒充。
- 文件 / 终端：旧文件标签保留源根与脏编辑，目标新文件管理器用目标根；旧终端记 `originWorkspace`、不重开；迁移打开跳过 `resetWorkspaceTabs`。
- 历史链接（本场景真实跑）：真实 `AppLinkGuard` + `LazyMarkdown` + `data-source-cwd` 指向源项目，点击后按源绝对路径请求；源文件不存在时在该路径的文件标签里报错；全程没有任何对目标项目同名文件的读取，也没有打开它的内容；既有脏文件标签与未保存修改都保留。

## 未验范围

- 真实主进程 owner、journal、runtime 与生产 IPC 由 6.1 探针与主进程测试覆盖，本场景只 stub 后端 I/O。
- 冷启动后 `transfer` 缺省且 backend 无 `sourceCwd` 时，只能按 backend 行的来源推断；若后端未带来源，旧 ui-history 辅助条目维持原状（UI 侧不猜）。
- 历史图片 / 音频资源卡的来源投影由 history agent 的共享组件与测试覆盖；本场景只覆盖历史 Markdown 文件链接这一条路径。
