# 升级 pi-coding-agent 的检查清单

进程内嵌 SDK 后，以下几处与上游实现耦合，升级时必须逐条核对：

1. **`cli/src/json-event.ts`** —— 自持的 `toJsonEvent` 等价实现。
   比对 `node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js`。
   变了就同步，否则渲染层收到的事件形状会漂移。

2. **`session.prompt` 的 preflight 时序** —— `PiRuntimeService` 依赖
   「仅 `true` 时 resolve，`false` 留给 `.catch`」以及
   `images / streamingBehavior / source:"rpc"` 转发。比对
   `dist/modes/rpc/rpc-mode.js` 的 prompt 分支。

3. **依赖与模型运行时** —— 同步 CLI、扩展和 Electron 的 Pi 直接依赖及锁文件。核对内置目录、自定义覆盖、鉴权和实际模型请求；按[最近的 SDK 升级记录](../.agents/notes/implemented/architecture/2026-11-10-pi-sdk-1.5.1-upgrade.md)选择定向验证。

4. **`ExtensionUIContext` 接口** —— `SessionUiAdapter` 必须仍是
   与当前 SDK 类型保持一致；核对上游新增方法和 TUI 专用能力在桌面端的处理。
   `custom` 必须 async。

5. **原生模块与相邻资源** —— 升级后重跑打包冒烟：
   `@ast-grep/napi`、`node:sqlite`、`runner.py` / `prompts/`、
   核对 `electron-builder.yml` 的生产输入 `out-pkg/` 与安装包内 `out/` 的映射及解包规则。
   扩展打进 `chunks/` 后 `import.meta.url` 指向 chunk，相邻资源须同时在
   `out/main/` 与 `out/main/chunks/`。

6. **两套副本** —— `electron-agent` 的 `resolve.dedupe` 三包必须仍生效；
   `require.resolve('@earendil-works/pi-ai')` 在主进程与 worker 解析到同一份。

7. **`toolcall_*` 事件形状** —— 核对 `toolcall_start` / `toolcall_delta` /
   `toolcall_end` 与 `electron-agent/electron/agent/streamingEvent.ts`。
   `toJsonEvent` 仍不带 `id` / `toolName` 的 delta，由 `streamingEvent.ts` 从
   partial 补发；形状变了要同步 reducer 的 `applyToolcallEvent`。
