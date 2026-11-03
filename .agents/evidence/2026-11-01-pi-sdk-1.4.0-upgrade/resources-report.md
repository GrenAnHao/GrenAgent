# Pi SDK 1.4.0 生产资源与打包边界审计

结论：本次 1.3.0 → 1.4.0 升级未发现需要新增生产资源复制规则的回归。生产构建的主要入口、字节码、相邻资源以及 codemode worker 的实际执行已验证。最终安装器 / asar 没有制作，不能据此声称完整打包后的默认资源定位已经通过。

本审计没有修改生产代码、安装依赖、启动应用 main、读取真实凭据或调用模型端点。只在 `.tmp-pi-sdk-1.4/` 写入报告、隔离探针与日志。

## 已核实的配置与产物

- 已读 `AGENTS.md`、`docs/pi-sdk-upgrade-checklist.md`，并核对 `.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md`、`2026-10-04-official-codemode-no-builtin-mcp.md`、`2026-10-17-pi-1.3.0-upgrade.md` 及生产输出目录隔离笔记。
- 实体解析从 `electron-agent/node_modules/@earendil-works/pi-coding-agent` 开始，coding-agent、agent-core、ai、codemode、tui、mcp、telemetry 均为 1.4.0；没有把 `.pnpm` 旧版本残留当成实际导入图。
- `electron-agent/electron.vite.config.ts` 的生产模式仍以 CJS 字节码构建，`externalizeDeps:false`；原生边界只外置 node-pty、CodeGraph、ast-grep、ripgrep 与 `node:`。三项 Pi dedupe 规则仍在。输出为 `out-pkg/`，不覆盖 dev/localrun 的 `out/`。
- fresh build 中 `main`、`pi-worker`、`agent-host`、`agentdata-host`、`codegraph-host`、`codegraph-worker`、`chunks/worker` 的 `.js` 与 `.jsc` 均存在且非空，`bytecode-loader.cjs`、`repo-wiki-host.cjs`、`package.json` 均存在；包标记为 `commonjs`。
- `codemodeWorkerBuild.ts` 的官方 worker 源入口仍存在，SDK `runtime/host.js` 仍相邻查找 `worker.js`；生产实际生成 `out-pkg/main/chunks/worker.js` 和 `.jsc`。`asarUnpack` 仍覆盖 `out-pkg/main/chunks/**`。
- `copyPiAdjacentAssets.ts` 的所有源文件均存在，`runner.py` / `runner.mjs`、两个 sandbox exe、job guard、Fable prompts、GPT with Taste texts/LICENSE、Ultra rules 在生产主目录和 chunks 目录均与源逐字节相同。最终重建后重验 35 条产物 / 内容断言，全部通过，8 项关键产物 SHA256 在 `resources-final-build-assertions.json`。
- SDK 自带 themes、HTML export 模板与 vendor、官方 codemode worker、image-resize worker、README/CHANGELOG 均存在。真实 `quickjs-wasi@3.6.2/quickjs.wasm` 与 Photon WASM 存在。实际 ripgrep 二进制为 `@vscode/ripgrep-win32-x64@1.18.0/bin/rg.exe`，存在。
- `electron-builder.yml` 继续将 out-pkg 映射为最终 out/main、out/preload、dist；host / worker 字节码、loader、commonjs 标记与 chunks 全量 unpack，ripgrep / ast-grep / CodeGraph 原生目录也覆盖。唯一 `scripts/package*.cjs` 为 `package-codegraph.cjs`：afterPack 恢复 CodeGraph 平台包内被依赖收集器过滤的嵌套 node_modules。现有定向测试在临时目录实际拷贝并找到了 tree-sitter 两类 WASM。

## 1.4 新增资源与既有边界

1. **新增 HTML 导出 vendor：** `pi-coding-agent/dist/core/export-html/vendor/marked-cjk-friendly.min.js`。1.4 的 `dist/core/export-html/index.js:95` 新增读取，1.3 无此文件。当前安装的 1.4 SDK 完整 dist 中包含该文件；本仓没有单独白名单复制 SDK export-html 的规则。本次无需给 `copyPiAdjacentAssets` 加一条复制。最终 asar 的实际依赖收集内容未制作 / 解包核验。
2. **默认 QuickJS 解析仅验证到边界：** `pi-coding-agent/dist/config.js:403-405` 与 `pi-codemode/dist/wasm.js:9-10` 仍使用 `createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm')`。从裸 `out-pkg/main` / `chunks` 直接 resolve 会报 `MODULE_NOT_FOUND`，因为 pnpm 只把该传递依赖放在内部实体目录。最终 electron-builder 扁平收集与 `asarUnpack` 的运行时组合未验证；不可把裸 build 目录的结果直接当成最终 asar 结果。此路径与 1.3 逐字节相同。本次 worker 执行探针显式传入了真实安装的 WASM，证明的是实际 worker 字节码与该 WASM 可共同执行。
3. **生产 agent-host 启动有既有动态 import 警告：** smoke 记录三次 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，来自 `chunks/armin-*.jsc`。已定位到 `pi-ai/dist/env-api-keys.js:14,20-28` 对 `node:fs` / `node:os` / `node:path` 的动态 import；SDK 1.3 与 1.4 文件 SHA256 都是 `8166f316e3c8adaa8c089561c644169a89fdc9ef2d67a752bbba738a5415a616`。当前字节码 loader 使用 `vm.Script`，没有动态 import 回调。这会让该模块的 `_existsSync` / `_homedir` / `_join` 保持 null，Vertex ADC 文件探测不能据此视为已验证。普通隔离启动、MCP 与关停仍通过；没有把带此 stderr 的 smoke 描述成无警告启动。它不是 1.4 新增问题，本轮不改既有字节码架构。
4. **其他延迟 / 原生资源都是基线行为：** 两版 `pi-ai/dist/auth/oauth/load.js`、`dist/api/bedrock-converse-stream.lazy.js`、`dist/bun-oauth.js`、`dist/bedrock-provider.js` 逐字节相同。OAuth / Bedrock 的变量 import 仍需打包器显式嵌入或真实相对模块，未做真实登录 / Bedrock 调用。两版 coding-agent 的 image-resize worker / Photon / config 文件和 pi-tui native 路径代码逐字节相同，TUI native 目录清单无增删。图片 worker 加载失败后已有进程内回落；本轮没有执行图片转换。MCP / telemetry 未发现新增旁路非代码资源；pi-ai 新增 telemetry / identity / version 均为 JS。

## 已执行验证

- `node node_modules/vitest/vitest.mjs run electron/agent/copyPiAdjacentAssets.test.ts electron/agent/codemodeWorkerBuild.test.ts electron/agent/workerEntry.test.ts electron/agent/repoWikiWorkerEntry.test.ts electron/app/sourceCodeProtection.test.ts electron/app/codeGraph/sdkPackaging.test.ts`：**6 files / 29 tests passed**。日志 `resources-tests-localtemp.log`。初次 pnpm 被路径 canonicalize 权限阻止，改用 node 后初次 sandbox TEMP 发生 rename EPERM；将 TEMP/TMP 定向到工作区隔离目录后通过。前两次均未进入测试断言，不是产品失败。
- 首次生产 build 的 61 条资源源 / 输出断言全部通过：`resources-assertions.log`。最终 rebuild 后另跑 35 条产物与字节相同断言全部通过：`resources-final-build-assertions.json`。
- `node scripts/agent-host-smoke.mjs --entry out-pkg/main/agent-host.js --tools 6`：**exit 0 / 15 PASS**。临时 HOME、agentDir、runtime config、本地 MCP 桩；验证生产字节码启动、工作区打开、MCP 热停启、状态 / 命令 / 审批 / 扩展表、关停与 Windows job guard 清理。日志 `resources-agent-host-smoke.log`。该轮在最后一次 shell fallback 修正重建之前，启动警告如上；最终重建后已重验资源且执行以下两项探针。
- `node .tmp-pi-sdk-1.4/resources-runtime-probe.cjs`：Electron Node 实际运行最终生产 `chunks/worker.js/.jsc`，显式传入真实 installed QuickJS WASM，`text(6 * 7)` 得到文本 `42` 且 `done.ok:true`；随后最终 `repo-wiki-host.cjs` 在临时 HOME / data 下发 ready、响应 IPC shutdown、exit 0。**两项通过**；无模型请求。日志 `resources-runtime-probe.log`，Repo Wiki 仅有 SQLite ExperimentalWarning。

未运行完整 UI harness、正式 app main、付费模型端点、真实 OAuth / Bedrock / Vertex ADC、图片转换或完整 installer / asar 验证；这些不在本次资源审计的已通过声明中。
