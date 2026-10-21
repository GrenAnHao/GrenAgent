# Agent Note: 打包硬约束：CJS 字节码主进程、node-pty 预编译、主进程堆 4GB

Status: implemented

## Problem

### CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import

生产构建把 Electron main 打成 CJS 字节码。rolldown 遇到 `import.meta.resolve` 会把 `import.meta` 换成 `{}` 并报 `EMPTY_IMPORT_META`。`@earendil-works/pi-coding-agent` 的 exports 只有 `import` 条件。同一条构建里，`extensions/index.ts` 被 main 静态引用，又被 `embedded-runner` 从这条静态图内部动态引用，rolldown 报 `INEFFECTIVE_DYNAMIC_IMPORT`。渲染进程里 `platform/runtime` 和 `ToolExecution` 也是既静态又动态引用，动态 import 拆不出 chunk。

### 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制

`pnpm package` 在 `@electron/rebuild` 准备 `@homebridge/node-pty-prebuilt-multiarch@0.14.1` 时退出。node-gyp 报 `deps\winpty\src\winpty.gyp not found`。该包的 `files` 只含 `binding.gyp`、`lib/`、`scripts/`、`typings/`、Linux `prebuilds/` 和 `third_party/conpty`，不含 `src/` 与 `deps/winpty`。Windows 二进制由安装脚本里的 `prebuild-install` 解到 `build/Release`。`src/win/conpty.cc` 使用 `NODE_API_MODULE`。Electron 38.8.6（Node 22.22.0，ABI 139）可以直接 `require` 当前 Node 25（ABI 141）装好的 `conpty.node`。生产依赖闭包里带 `binding.gyp` 的只有这一个包。

### 主进程堆上限固定为 4GB，写在启动配置里

主进程老生代默认约 1.5GB。上一则笔记用 `app.relaunch` 在参数缺失时重启进程，把 4GB 补进去。那不是固定配置，打包进程和开发进程的启动方式也不一样。

### 主进程生产产物的文件名钉成 .js / .jsc，不吃构建工具的 .cjs 默认值

`package.json` 是 `"type": "module"`。2026-10-14 实测：`electron.vite.config.ts` 的 main 生产构建只写了 `output.format: "cjs"`，产物是 `main.cjs` / `main.cjsc`，chunk 也是 `.cjsc`。electron-vite 6.0.0-beta.1 的 main 配置只给 `es` 格式显式设扩展名（`.mjs`），`cjs` 没设，应是 Vite / rolldown 按 package 的 `type` 取默认值（推断）。

而其余几处都按 `.js` / `.jsc` 约定：`package.json` 的 `main` 是 `out/main/main.js`（`dev` 和 `localrun` 的 ESM 产物也叫 `main.js`），`electron-builder.yml` 的 `asarUnpack` 列的是 `pi-worker.js/.jsc`、`agent-host.js/.jsc`，`sourceCodeProtection.test.ts` 断言这些名字，`out/main/package.json` 的 `{"type":"commonjs"}` 就是为了让 `.js` 按 CJS 加载。结果 `npm run package` 在入口检查处退出：`Application entry file "out\main\main.js" ... was not found in this archive`，asar 里只有 `main.cjs`。main 的 `output` 段自 2026-09-20（1606768c）没改过，09-27 的 0.1.0 安装包和 10-02 的打包都过了入口检查，所以此前产物应该还是 `.js`；推断是之后装的依赖（electron-vite / Vite / rolldown）把 cjs 的默认扩展名换了，没有逐版本核对。

### 生产主进程不外置依赖，解包的 .js 桩旁边带 package.json

文件名对上后，2026-10-14 启动打包出来的 `GrenAgent.exe` 连着撞了三个问题：

1. 弹出 `A JavaScript error occurred in the main process`：`ERR_PACKAGE_PATH_NOT_EXPORTED`，指向 asar 里的 `@earendil-works/pi-coding-agent`。electron-vite 6.0.0-beta.1 的 `build.externalizeDeps` 默认是 `true`（`config.build?.externalizeDeps ?? true`），配置里没写过，`package.json` 的 `dependencies` 全被外置成运行时 `require`，而 Pi SDK 的 exports 只有 `import` 条件。09-11 的决定本来是把 Pi SDK 打进主进程，旧版本没有这个默认值所以成立。
2. 只把三个 Pi 包排除外置后，主进程能起来，`agent-host` 子进程报 `Cannot find module 'yaml'`。`agent-host` 和 `pi-worker` 的 chunk 在 `app.asar.unpacked/out/main/chunks/` 里按真实路径加载，往上找 `node_modules` 只能找到被 unpack 的那几个包，asar 里的 `yaml` 等外置依赖找不到。
3. 再往前，`agent-host.js` 报 `require is not defined in ES module scope`。Node 按真实文件系统给解包出来的 `.js` 找 `package.json`，`out/main/package.json`（`{"type":"commonjs"}`）只在 asar 里，找不到就一路找到外层 `type: module` 的那份。这次是在仓库里的 `release/win-unpacked` 复现的，外层是仓库自己的 `package.json`；装到普通目录会不会撞上取决于上层有没有 `package.json`，没有验证。

## Decision

38fd0163（2026-09-11）起，打包把 Pi SDK 去重、原生模块走 asarUnpack、拷贝 `import.meta.url` 引用的资源；下面三条是在此基础上逐步定下的硬约束。

推断（依据：commit 38fd0163 的 diff 及其前两个提交 7fb21e6f「drop sidecar process resolution」、b500de2a「remove sidecar binary, extraResources」；用户本人不记得这次改动。该提交带 `Co-authored-by: Cursor` 尾注，由 AI 代理协作生成）：sidecar 移除后，Pi SDK 不再作为 `resources/pi` 外置资源随包分发，而是直接打进 Electron 主进程。提交把 `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core` 加为 electron-agent 直接依赖，并在 `electron.vite.config.ts` 的 main 构建里对这三个包设 `resolve.dedupe`。可能的原因：仓库根的扩展和 electron-agent 各自能解析到一份 Pi SDK，dedupe 让主进程只打进一份，避免同一 SDK 出现两个模块实例。同一提交还把 `@ast-grep/napi` 与 worker 脚本设为 asarUnpack，并把 `import.meta.url` 引用的 runner.py / runner.mjs / prompts 拷到 `out/main`。

### CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import

`resolveInstalledPiPackageDir` 从 `import.meta.url` 所在目录向上找 `node_modules/@earendil-works/pi-coding-agent`。`import.meta.url` 在 CJS 产物里会改写成输出文件的 file URL。`embedded-runner` 改为动态 import `extensions/deferred-manifest.ts`，由它再导出 `manifestExtensions`。`pi-worker` 仍在设置 `PI_PACKAGE_DIR` 之后动态 import `extensions/index.ts`。`WikiClient`、`VisualCard`、`ContextToolGroup` 改为静态 import。

### 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制

在 `electron-agent/electron-builder.yml` 设置 `npmRebuild: false`，打包使用安装时已经放下的 Node-API 预编译二进制。

### 主进程堆上限固定为 4GB，写在启动配置里

上限固定为 4096MB。`electron.vite.config.ts` 在 `electron-vite` 拉起 Electron 之前把 `--js-flags=--max-old-space-size=4096` 写入 `ELECTRON_CLI_ARGS`。已经带有 `max-old-space-size` 时不追加。主进程不再因为堆上限重启。

### 主进程生产产物的文件名钉成 .js / .jsc，不吃构建工具的 .cjs 默认值

生产构建的 `output` 显式写 `entryFileNames: "[name].js"` 和 `chunkFileNames: "chunks/[name]-[hash].js"`。字节码插件据此产出 `main.js`（几十字节的加载桩）+ `main.jsc`，chunk 在 `out/main/chunks/*.jsc`。preload 段早就用同样的办法钉了 `[name].js`（97f06825）。格式仍是 CJS，字节码保护不变；`dev` / `localrun` 不走这个分支，照旧输出 ESM `main.js`。

### 生产主进程不外置依赖，解包的 .js 桩旁边带 package.json

生产构建在 main 的 `build` 里设 `externalizeDeps: false`：除 `mainExternal` 里列的原生模块（node-pty、codegraph、ast-grep、ripgrep，都已 asarUnpack）之外，依赖一律打进主进程和 chunk，Pi SDK 也在其中。`dev` / `localrun` 不走这个分支，仍沿用 electron-vite 的默认外置，ESM 下 `import` 条件能解析。`electron-builder.yml` 的 `asarUnpack` 加 `out/main/package.json`，解包出来的 `agent-host.js`、`pi-worker.js` 旁边有 `{"type":"commonjs"}`，按 CJS 加载，不依赖外层目录有没有 `package.json`。

pi-codemode 也随之打进 chunk。它的 `runtime/host.js` 默认用 `new URL("./worker.js", import.meta.url)` 起 worker 线程，打包后这个地址落在 host 所在 chunk 的同一目录，也就是 `out/main/chunks/worker.js`。生产构建因此多一个 main 入口 `chunks/worker`，源文件是 pi 给打包版准备的 `pi-coding-agent/dist/extensions/codemode/worker.js`（只 `import "@earendil-works/pi-codemode/worker"`），字节码插件照常出成 `chunks/worker.js` 桩 + `chunks/worker.jsc`，被 `out/main/chunks/**` 一并解包。`check-codemode-worker` 插件在 `generateBundle` 里核对：host 所在 chunk 的目录旁边必须有 `worker.js` 入口，否则构建失败（`electron/agent/codemodeWorkerBuild.ts`）。

### 涉及文件

- `cli/src/official-package-dir.ts`
- `extensions/deferred-manifest.ts`
- `extensions/multi-agent/embedded-runner.ts`
- `extensions/wiki-rag/client.ts`
- `electron-agent/src/features/visual/VisualCard.tsx`
- `electron-agent/src/features/tools/ContextToolGroup.tsx`
- `electron-agent/electron-builder.yml`
- `electron-agent/electron/agent/codemodeWorkerBuild.ts`
- `electron-agent/electron/mainHeap.ts`
- `electron-agent/electron.vite.config.ts`
- `electron-agent/electron/main.ts`

### 来源

- `docs/decisions/build/2026-10-02-rolldown-cjs-import-meta.md`
- `docs/decisions/build/2026-10-02-skip-node-pty-electron-rebuild.md`
- `docs/decisions/electron-agent/2026-10-03-main-process-heap-fixed.md`
- `docs/decisions/electron-agent/2026-10-03-main-process-heap.md`（已被取代）
- 38fd0163

## Alternatives considered

### CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import

- `transform.define` 把 `import.meta` 定义成 `{}`，或关掉 `checks.emptyImportMeta`：警告没了，`import.meta.resolve` 在生产包里仍是空对象。
- `createRequire(import.meta.url).resolve`：该包没有 `require` 导出条件，解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- 生产 main 改回 ESM：字节码保护要求 CJS。开发时 `electron-vite serve` 仍是 ESM。
- `embedded-runner` 静态 import `extensions/index.ts`：和 `index → multi-agent → embedded-runner` 成环。
- `pi-worker` 顶部静态 import 扩展：扩展图会在 `applyOfficialMainPackageDir` 之前加载。
- 关掉 `checks.ineffectiveDynamicImport`：以后真正拆不出去的动态 import 也不再提示。

### 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制

- 继续让 electron-rebuild 从源码编译：发布包里没有 `winpty.gyp` 和 `src/`，node-gyp 无法完成配置。日志里的 “space in the path” 是 node-gyp 警告，进程是在找不到 `winpty.gyp` 时退出的。
- 换到带 Electron 专用预编译的发行包：当前 `conpty.node` 已在 Electron 38.8.6 中加载，换包还要改 main 进程 external 与 import。
- `beforeBuild` 返回 false，再自己调用 `@electron/rebuild` 并 `ignoreModules`：electron-builder 会把 node_modules 视为外部处理，跳过生产依赖收集。
- 打包前删掉 `binding.gyp` 让 walker 跳过该模块：改的是 `node_modules`，下次安装会恢复。

### 主进程堆上限固定为 4GB，写在启动配置里

- 缺参数就 `app.relaunch`：多一次进程启动，而且上限不是启动配置的一部分。
- `app.commandLine.appendSwitch('js-flags', ...)`：主进程的 V8 堆在 JS 执行前已经建好，这个开关改不到它。

### 主进程生产产物的文件名钉成 .js / .jsc，不吃构建工具的 .cjs 默认值

- `package.json` 的 `main` 改成 `out/main/main.cjs`，`asarUnpack` 和测试跟着改成 `.cjs` / `.cjsc`：最顺工具链默认值，不用在配置里写文件名。但 `dev`、`localrun` 的 ESM 产物叫 `main.js`，共用同一个 `package.json`，`main` 只能写一个值，改成 `main.cjs` 本机开发就找不到入口。
- 只改 `electron-builder.yml`、让它认 `.cjs`：入口检查读的是 `package.json` 的 `main`，对不上的还是它。
- 关掉字节码或把生产主进程改回 ESM：能绕开命名问题，但源码保护就没了；本条上面已经定了字节码保护要求 CJS。
- 构建后再把 `.cjs` / `.cjsc` 批量改名：多一道构建后的文件操作，生成的加载桩里 `require("./main.cjsc")` 这类引用也要同步改，比在 `output` 里直接钉名字脆。

### 生产主进程不外置依赖，解包的 .js 桩旁边带 package.json

- 只排除三个 Pi 包（`externalizeDeps: { exclude: [...] }`）：改动最小，其余依赖仍从 asar 里加载，体积增长也最小。试过，主进程能起来，但 `agent-host` 报 `Cannot find module 'yaml'`；要用这个办法就得把每个外置依赖都补进 `asarUnpack`，名单要和 `dependencies` 同步，漏一个就是运行时才炸。
- 把外置依赖整体 `asarUnpack`（`node_modules/**`）：能让解包的 chunk 找到包，但 Pi 包的 `require` 问题还在，还把 asar 的完整性保护和体积优势一起放掉。
- 把 `agent-host` / `pi-worker` 的加载桩改成 `.cjs`，避开 `package.json` 查找：确实绕得开，但要改字节码插件的输出名、`asarUnpack` 和测试，和上一条钉死 `.js` / `.jsc` 的约定冲突；多 unpack 一个 `package.json` 更小。
- codemode worker 改走 pi 自己的打包路径：在 main 构建里 `define` 出 `PI_BUNDLED_NODE = true`，`getCodemodeWorkerSpecifier()` 就会读同目录的 `codemode-worker.js` 并转成 data: URL，更新时文件被替换也不受影响，是 pi 官方 Node 发行版用的办法。没用它，是因为同一个开关还让 `core/extensions/loader.js` 改走内嵌模块（`usesEmbeddedModules`），扩展加载方式跟着变，波及面远大于补一个 worker 入口。
- 把 pi-codemode 留在外置名单里，让它用 node_modules 里自带的 `worker.js`：它和 Pi SDK 一样 exports 只有 `import` 条件，CJS 主进程 `require` 它会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

### 已被取代的旧决定：主进程 V8 老生代上限从约 1.5GB 提到 4GB

启动参数使用 `--js-flags=--max-old-space-size=4096`。`electron-vite` 通过 `ELECTRON_CLI_ARGS` 在拉起 Electron 之前写上。打包后的 exe 若参数里还没有这一项，主进程在创建窗口前 `relaunch` 一次再退出。

当时放弃的方案：

- `app.commandLine.appendSwitch('js-flags', ...)`：主进程的 V8 堆在 JS 执行前已经建好，这个开关只影响之后拉起的子进程。
- 只改开发脚本、不处理打包后的 exe：发出去的 GrenAgent 仍停在 1.5GB。
- 提到 8GB：机器内存不一定够，4GB 已经是当前上限的两倍多。

## Consequences

### CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import

安装目录必须出现在输出文件的祖先 `node_modules` 里。`NODE_PATH` 或其他非祖先位置不再被 `import.meta.resolve` 找到；找不到时保持原来的 `PI_PACKAGE_DIR`。`deferred-manifest` 会多一个很小的异步 chunk，只为把环留到 `filterExtensionFactories` 调用时。不要改回对 `extensions/index.ts` 的直接动态 import，否则 `INEFFECTIVE_DYNAMIC_IMPORT` 会回来。

### 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制

以后若加入必须按 Electron ABI 重编、且不是 Node-API 的原生模块，需要重新打开 `npmRebuild`，或只为那个模块提供 Electron 预编译。`build/Release/conpty.node` 来自安装时的 `prebuild-install`；打包前若该目录被 node-gyp 清掉，要重跑该包的安装脚本或 `pnpm install`，否则安装包里没有可用的 PTY。

### 主进程堆上限固定为 4GB，写在启动配置里

`electron-vite dev` 和 `preview` 拉起的主进程老生代上限是 4GB。同一条 `--js-flags` 也会作用到随后启动的渲染进程。不经过 `electron-vite` 直接打开的打包 exe 仍使用 Electron 默认上限。

### 主进程生产产物的文件名钉成 .js / .jsc，不吃构建工具的 .cjs 默认值

产物名不再依赖 electron-vite / rolldown 的默认值，升级它们不会悄悄把入口改回 `.cjs`；代价是 `output` 里多两行，`chunks/` 目录名也要自己和 `asarUnpack` 的 `out/main/chunks/**` 保持一致。别在这段 `output` 里换扩展名，`package.json` 的 `main`、`asarUnpack` 和 `sourceCodeProtection.test.ts` 都按 `.js` / `.jsc` 写死。`out/main/package.json`（`{"type":"commonjs"}`）必须随生产构建写出，否则这些 `.js` 会被当 ESM 加载。生产构建和 `electron-vite dev` 写同一个 `out/main`（dev 还会删掉 `out/main/package.json`），同一个工作区里两者不要同时跑，会互相覆盖。

### 生产主进程不外置依赖，解包的 .js 桩旁边带 package.json

依赖不再靠 asar 里的 `node_modules` 在运行时解析：`main.jsc` 约 1.0MB → 1.5MB，chunk 24 个 → 77 个、约 22MB。新加的依赖只要进主进程图就会被打进去，不用再管 asar 内外的解析路径；代价是 ESM-only 或用 `import.meta` 的依赖会在构建时报 `EMPTY_IMPORT_META` 这类警告，要逐个看。`asarUnpack` 里的 `out/main/package.json` 不能删，删了解包的 `.js` 桩又会被外层的 `type: module` 当 ESM。

已知遗留，都是 2026-10-14 在打包后的 exe 里看到、没有处理的：

- pi-ai 的 `env-api-keys.js` 启动时 `import("node:fs")` 等三个动态导入，在字节码里抛 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，stderr 里是未处理的 Promise 拒绝警告。它只负责 Google Vertex ADC 凭据探测，失败时探测恒为 false，其余启动不受影响。
- pi-coding-agent `core/extensions/loader.js:51` 的 `import.meta.resolve` 被替换成 `{}`（构建时的 `EMPTY_IMPORT_META` 就是它）。只在 pi 用 jiti 加载文件形式的扩展、算别名时才会走到，没有验证过。
- codemode：2026-10-19 在 0.3.0 打包版里确认坏了，每次调用都报 `Cannot find module ...\out\main\chunks\worker.js`，一次工具调用都发不出去。已按 Decision 里的 `chunks/worker` 入口修好。`quickjs.wasm` 按 `createRequire(chunk).resolve("quickjs-wasi/quickjs.wasm")` 从 `app.asar.unpacked/node_modules` 找到，报错发生在 wasm 加载之后、起 worker 的时候，说明这一段是通的。`asarUnpack` 里 pi-codemode 那行 `dist/runtime/worker.js` 在打包版里不再被用到，留着没删。

## Verification

前三条：verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证

后两条（产物文件名钉成 .js / .jsc；生产主进程不外置依赖、解包的 .js 桩旁边带 package.json），2026-10-14 实跑，结果：部分通过（能启动、agent-host 能拉起，下面「没验证」几项除外）。

按出现顺序，每一步都是修之前失败、修之后过：

- 只改文件名之前 `npm run build && npm run package`：`out/main` 是 `main.cjs` / `main.cjsc`，打包在入口检查处退出，报 `Application entry file "out\main\main.js" ... was not found in this archive`。钉成 `.js` 后打包成功。
- 启动那次打出来的 `release/win-unpacked/GrenAgent.exe`：弹出 `ERR_PACKAGE_PATH_NOT_EXPORTED`（Pi 外置），读弹窗文字确认。只排除三个 Pi 包后主进程能起来，`agent-host` 报 `Cannot find module 'yaml'`；再往前报 `require is not defined in ES module scope`（缺解包的 `package.json`）。
- 最终配置（`externalizeDeps: false` + `asarUnpack` 加 `out/main/package.json`）下，`npm run build` 后 `out/main` 为 `main.js`（71 字节桩）+ `main.jsc`（约 1.5MB），`chunks/` 下 77 个 `.jsc`、约 22MB；`npm run package` 退出码 0，产出 `release/GrenAgent Setup 0.3.0.exe`（约 231MB）。
- 启动最终产物 `release/win-unpacked/GrenAgent.exe`（`--user-data-dir` 指向临时目录，等 25 秒后观察，之后只杀自己起的进程树）：主进程、GPU、渲染进程、`agent-host` 子进程、`pi-job-guard.exe` 都在，30 行 `extension loaded` 日志，stderr 里没有 `failed to start`、`Cannot find module`、`ReferenceError`、`ERR_PACKAGE`。退出后没有 GrenAgent 残留进程。
- `cd electron-agent && npx vitest run electron/app/sourceCodeProtection.test.ts electron/mainHeap.test.ts`：2 个文件 10 条通过（含新增的 `out/main/package.json` 要在 `asarUnpack` 里的断言）。
- codemode worker（2026-10-19，结果：通过）：`npx electron-vite build` 产出 `out/main/chunks/worker.js`（74 字节桩，`require("../bytecode-loader.cjs")` + `require("./worker.jsc")`）和 `worker.jsc`，`check-codemode-worker` 没报错。用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe` 起 pi-codemode 的 `CodemodeSandbox`，`workerUrl` 指向这个桩，执行 `await tools.search(...)` 再 `return 42`：`ok: true`、`value: 42`、调用一次、输出正确。`npx vitest run electron/agent/codemodeWorkerBuild.test.ts`：4 条通过。没有重新 `npm run package`，因为那会覆盖正在运行的 `release/win-unpacked`；打包版里的确认要等下次打包后在界面里跑一次 codemode。
- 没验证：运行的是 `win-unpacked` 里的同一份文件，没有真的跑 NSIS 安装程序、没有在非仓库目录下启动；没有在界面里发消息、开会话，所以 Pi 运行时、codemode、文件形式扩展（见 Consequences 的已知遗留）都没走到；也没做 `npm run start` / `dev` 的回归。启动时 MCP 配置读的是真实 `~/.pi`，拉起了其中的 MCP 服务器，没有做写操作。
