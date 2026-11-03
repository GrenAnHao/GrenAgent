# 会话视图展开状态持久化（view-*）

范围：会话视图展开状态按 owner（会话 JSONL 路径 / `draft:<uuid>`）+ 稳定内容 ID 持久化，
含工具卡、上下文组、codemode、思考正文；dock 草稿身份 draftId；草稿首发过户与删除清理。

## 导出 API

`src/stores/sessionViewStateStore.ts`（browser-safe，localStorage，逐 owner 键 `pi-session-view-state:<owner>`）
- `useSessionViewStateStore`：`isExpanded(owner,viewId)`、`setExpanded(owner,viewId,bool)`、`toggle(owner,viewId)`、
  `adopt(fromOwnerKey,toSessionPath)`、`remove(ownerKey)`、`hydrateFromStorage()`
- `isPersistableViewOwnerKey(key)`、`sessionViewStateKeyFor(ownerKey)`、`sessionViewStateStorageKey()`、
  `resetSessionViewStateForTests({keepStorage?})`

`src/features/chat/useSessionViewExpanded.ts`
- `useSessionViewOwnerKey(): string | null`（AgentStoreContext 的 sessionPath/draftId > 全局 activeSessionPath/draftConversationId > null）
- `useSessionViewExpandedState(viewId, defaultExpanded=false): { expanded, setExpanded(boolean | (prev)=>boolean), toggle(), persisted }`

内容 ID 约定：`tool:<toolCallId>`、`codemode:<toolCallId>`、`codemode-calls:<toolCallId>`、
`codemode-record:<toolCallId>:<callKey>`、`context:<组内首个 toolCallId>`、`thinking:<assistant timestamp>`、
`invalid:<toolCallId>`。

## RED / GREEN

- `view-updater-red.log`：hook 只接受 boolean 时，函数式 setter 用例 + 真实组件点击用例 7 条失败
  （`expected [Function] to be true`、store 值 `undefined`、`reasoning-stream-body` 不收起）。
- `view-updater-green.log`、`view-tools-green.log`：修完 setter 兼容后 25 条全过（hook 9 + 工具 6 + store 10）。
- `view-viewstate-green.log`：41 文件 / 333 条通过（store、hook、dock、plan、visual、组件回归）。
- `view-regression-green.log`：ToolExecution / TurnTimeline / ChatMessageItems 70 条通过
  （含 AgentStoreContext 被 mock 成无 Context 导出时的兜底修复）。
- `view-final-tools.log`：工具与思考卡相关 5 文件 / 84 条。
- `view-ui-session-preferences.log`：真实 UI 场景 98 条 PASS，含「工具卡函数式展开写入布尔状态」、
  「同工具 ID 的 B 仍保持收起」、「页面重载后 A 上下文展开」。
- `view-ui-tool-cards.log`：codemode-card 55 + invalid-arguments-card 27 全 PASS。
- `view-final-viewstate.log`：6 文件 / 72 条（store、hook、dock、dock switch、ContextToolGroup、toolViewExpansion）。
- `view-verify-notes.log`：114 篇笔记 tree/format/链接通过；既有 6 篇「记了测试但没写结果」非阻断警告，本次未新增警告。
- `view-tsc.log`：定向 include 的 tsc 只剩两条既有错误（`messageActions/types.ts` 缺 agentReducer 声明、
  `StreamingCodeView.tsx` shiki 主题类型），与本次改动无关；本次新增文件单独 tsc 干净。

## 已知限制 / 偏差

- store 与 hook 先实现后补测试（其余按 RED→GREEN），本报告如实保留该偏差。
- dock 的持久化（zustand persist 整表）本次未升级，只核对 draftId 身份；dock 内存态按 draftId 隔离。
- 视图验证期间曾遇到 `ChatView.test.tsx` 的 `/goal` 命令列表和首发失败用例变红。主线程已定位为本轮在途 TDD 与新增 `/compact` 用例的 store 清理缺失，已修复；不是既有偶发失败。最新主线程 6 文件 / 92 条通过，见 `main-integration-green.log`。
- 未跑无关全量 UI 场景。
