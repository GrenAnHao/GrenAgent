# Pi 1.5.1 Node 懒加载接入

## 实现与消费路径

- `cli/src/pi-node-providers.ts` 只调用官方 `registerLazyOAuthFlows()` / `registerLazyBedrockProvider()`，不预先加载实现、不读写认证。
- 桌面主进程供应商服务与 agent-host 经既有 `cli/src/pi-sdk.ts` 注册；独立 CLI 的 `runtime.ts` 和 `pi-worker.ts` 各自导入同一 bootstrap。各进程在自己的 SDK 模块实例内注册，ESM 缓存保证一个入口只执行一次。
- 官方入口只替换 loader，重复调用仍指向相同官方实现，无需增加本地单飞/状态注册表。原 `loginWithOptions` 适配、凭据文件所有权和配置协议均未改。
- 生产 CJS 多 chunk 必须启用 Rolldown 官方 `strictExecutionOrder`，否则 Pi compat 与扩展 virtual-modules 的跨 chunk 环导致 `image-models` 在 `IMAGE_MODELS` 导出之前执行。保留自动分包与真正懒加载，不手工合并 SDK 或全量静态导入实现。

## 红灯与修复

1. 新增独立分割 bundle 回归测试，修复前实际报 `ERR_MODULE_NOT_FOUND: .../meta.ts`：打包后官方变量 import 指向了输出目录中不存在的实现。接入官方入口后测试通过。
2. 初次生产构建退出 0，但正式隔离 `agent-host.js` 发出 `host.fatal: TypeError: Cannot convert undefined or null to object`，位置 `virtual-modules-*.jsc`，并警告 `IMAGE_MODELS` 环依赖，见 `production-smoke-red.log`。
3. 同配置临时非字节码输出定位为 compat ↔ virtual-modules 的 CJS 初始化顺序；只增加 `output.strictExecutionOrder: true` 后，正式字节码两入口均 ready 且懒加载烟测通过。

旧的 `env-api-keys` 变量动态 import 在绕开正式入口的直接 require 调试中出现过 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`；严格初始化后，本次正式入口、真实 ModelRuntime 与所有新 loader 消费路径未复现。没有据此改写生成的 bytecode loader，也没有把所有动态 import 改成 require。

## 通过的检查

| 检查 | 结果与日志 |
| --- | --- |
| CLI `node --import tsx --test src/pi-node-providers.test.ts src/runtime.test.ts src/pi-worker.test.ts` | 6/6；`cli-tests.log` |
| Electron `npx vitest run electron/agent/copyPiAdjacentAssets.test.ts electron/agent/codemodeWorkerBuild.test.ts electron/agent/workerEntry.test.ts electron/app/providerService.test.ts` | 4 文件 46/46；`electron-tests.log` |
| Electron `npm run build`（真实生产分割/字节码配置） | 退出 0；最终候选见 `electron-build-strict.log` |
| Electron `node scripts/smoke-pi-node-providers.mjs` | agent-host 与 pi-worker 均 ready，真实 ModelRuntime 用合成 Meta 凭据 getAuth，9 项 OAuth 与 Bedrock 实现均按需实际加载；`production-smoke-strict.log` |
| CLI `npm run build` 与 `node dist/main.js --help` | 退出 0；`cli-build.log` / `cli-help.log` |

生产烟测使用当前项目的 Electron 38 / Node 22 执行实际 `.jsc`，不是系统 Node 直接执行字节码。它创建隔离 HOME/USERPROFILE/APPDATA/agentDir、清除继承的 API/厂商环境，阻断 fetch/http/https/http2 网络出口，不启动会话、不登录/登出、不发送模型请求。检查实现 chunk 在 ready 时尚未加载，调用官方 loader 后进入 require.cache；Bedrock 在读取测试 context 的首个 getter 时受控中断，未走到 AWS 凭据链与网络。

CLI help 正常输出，但现有打包缺少 `dist/ultra-rules.md` 会在此前记录 ENOENT 警告；该旁路资源未纳入本次懒加载修改。未运行不相关的全量测试或 UI-harness。

## 快照与源依据

目标文件修改前快照及遮挡本次消费的 4 个未跟踪生成 JS 保存在 `%TEMP%/pi-lazy-providers-20261110/`：`cli/src/pi-sdk.js`、`runtime.js`、`pi-worker.js`、`electron-agent/electron.vite.config.js`。未清理其他生成文件。

- 本地已安装 `@earendil-works/pi-ai@1.5.1/dist/lazy-oauth.js`、`lazy-bedrock-provider.js`、`auth/oauth/load.js`、`api/bedrock-converse-stream.lazy.js`。
- [官方 OAuth Node bundle 入口](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/src/lazy-oauth.ts)、[官方 Bedrock 入口](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/src/lazy-bedrock-provider.ts)。
- [Rolldown strictExecutionOrder](https://rolldown.rs/reference/OutputOptions.strictExecutionOrder) 保留跨 chunk 的源模块执行顺序；代价是初始化 helper 增加少量产物体积。
