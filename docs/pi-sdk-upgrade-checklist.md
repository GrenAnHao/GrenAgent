# 升级 pi-coding-agent 的检查清单

进程内嵌 SDK 后，以下几处与上游实现耦合，升级时必须逐条核对：

1. **`cli/src/json-event.ts`** —— 自持的 `toJsonEvent` 等价实现。
   比对 `node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js`。
   变了就同步，否则渲染层收到的事件形状会漂移。

2. **`session.prompt` 的 preflight 时序** —— `PiRuntimeService` 依赖
   「仅 `true` 时 resolve，`false` 留给 `.catch`」以及
   `images / streamingBehavior / source:"rpc"` 转发。比对
   `dist/modes/rpc/rpc-mode.js` 的 prompt 分支。

3. **`describeModel()`** —— 返回 `provider/id` 字符串
   （`agentData/runtime.ts` 的 `expectedModel` 相等比较）。
   解析链是 settings `defaultProvider` + `defaultModel` → `getModel` +
   `hasConfiguredAuth` → `getAvailableSnapshot()`。上游新增 fallback 时同步
   `ModelRuntimeHost.resolveDefaultModel`。

4. **`ExtensionUIContext` 接口** —— `SessionUiAdapter` 必须仍是
   28 项自有可枚举属性；上游新增方法时补上（TUI 专用的给 no-op）。
   `custom` 必须 async。

5. **原生模块与相邻资源** —— 升级后重跑打包冒烟：
   `@ast-grep/napi`、`node:sqlite`、`runner.py` / `prompts/`、
   `asarUnpack` 仍含 `@colbymchenry/**` 与 `out/main/chunks/**`。
   扩展打进 `chunks/` 后 `import.meta.url` 指向 chunk，相邻资源须同时在
   `out/main/` 与 `out/main/chunks/`。

6. **两套副本** —— `electron-agent` 的 `resolve.dedupe` 三包必须仍生效；
   `require.resolve('@earendil-works/pi-ai')` 在主进程与 worker 解析到同一份。

7. **`toolcall_*` 事件形状** —— 核对 `toolcall_start` / `toolcall_delta` /
   `toolcall_end` 与 `electron-agent/electron/agent/streamingEvent.ts`。
   `toJsonEvent` 仍不带 `id` / `toolName` 的 delta，由 `streamingEvent.ts` 从
   partial 补发；形状变了要同步 reducer 的 `applyToolcallEvent`。
