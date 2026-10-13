# Agent Note: 打包硬约束：CJS 字节码主进程、node-pty 预编译、主进程堆 4GB

Status: implemented

## Problem

### CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import

生产构建把 Electron main 打成 CJS 字节码。rolldown 遇到 `import.meta.resolve` 会把 `import.meta` 换成 `{}` 并报 `EMPTY_IMPORT_META`。`@earendil-works/pi-coding-agent` 的 exports 只有 `import` 条件。同一条构建里，`extensions/index.ts` 被 main 静态引用，又被 `embedded-runner` 从这条静态图内部动态引用，rolldown 报 `INEFFECTIVE_DYNAMIC_IMPORT`。渲染进程里 `platform/runtime` 和 `ToolExecution` 也是既静态又动态引用，动态 import 拆不出 chunk。

### 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制

`pnpm package` 在 `@electron/rebuild` 准备 `@homebridge/node-pty-prebuilt-multiarch@0.14.1` 时退出。node-gyp 报 `deps\winpty\src\winpty.gyp not found`。该包的 `files` 只含 `binding.gyp`、`lib/`、`scripts/`、`typings/`、Linux `prebuilds/` 和 `third_party/conpty`，不含 `src/` 与 `deps/winpty`。Windows 二进制由安装脚本里的 `prebuild-install` 解到 `build/Release`。`src/win/conpty.cc` 使用 `NODE_API_MODULE`。Electron 38.8.6（Node 22.22.0，ABI 139）可以直接 `require` 当前 Node 25（ABI 141）装好的 `conpty.node`。生产依赖闭包里带 `binding.gyp` 的只有这一个包。

### 主进程堆上限固定为 4GB，写在启动配置里

主进程老生代默认约 1.5GB。上一则笔记用 `app.relaunch` 在参数缺失时重启进程，把 4GB 补进去。那不是固定配置，打包进程和开发进程的启动方式也不一样。

## Decision

38fd0163（2026-09-11）起，打包把 Pi SDK 去重、原生模块走 asarUnpack、拷贝 `import.meta.url` 引用的资源；下面三条是在此基础上逐步定下的硬约束。

推断（依据：commit 38fd0163 的 diff 及其前两个提交 7fb21e6f「drop sidecar process resolution」、b500de2a「remove sidecar binary, extraResources」；用户本人不记得这次改动。该提交带 `Co-authored-by: Cursor` 尾注，由 AI 代理协作生成）：sidecar 移除后，Pi SDK 不再作为 `resources/pi` 外置资源随包分发，而是直接打进 Electron 主进程。提交把 `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core` 加为 electron-agent 直接依赖，并在 `electron.vite.config.ts` 的 main 构建里对这三个包设 `resolve.dedupe`。可能的原因：仓库根的扩展和 electron-agent 各自能解析到一份 Pi SDK，dedupe 让主进程只打进一份，避免同一 SDK 出现两个模块实例。同一提交还把 `@ast-grep/napi` 与 worker 脚本设为 asarUnpack，并把 `import.meta.url` 引用的 runner.py / runner.mjs / prompts 拷到 `out/main`。

### CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import

`resolveInstalledPiPackageDir` 从 `import.meta.url` 所在目录向上找 `node_modules/@earendil-works/pi-coding-agent`。`import.meta.url` 在 CJS 产物里会改写成输出文件的 file URL。`embedded-runner` 改为动态 import `extensions/deferred-manifest.ts`，由它再导出 `manifestExtensions`。`pi-worker` 仍在设置 `PI_PACKAGE_DIR` 之后动态 import `extensions/index.ts`。`WikiClient`、`VisualCard`、`ContextToolGroup` 改为静态 import。

### 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制

在 `electron-agent/electron-builder.yml` 设置 `npmRebuild: false`，打包使用安装时已经放下的 Node-API 预编译二进制。

### 主进程堆上限固定为 4GB，写在启动配置里

上限固定为 4096MB。`electron.vite.config.ts` 在 `electron-vite` 拉起 Electron 之前把 `--js-flags=--max-old-space-size=4096` 写入 `ELECTRON_CLI_ARGS`。已经带有 `max-old-space-size` 时不追加。主进程不再因为堆上限重启。

### 涉及文件

- `cli/src/official-package-dir.ts`
- `extensions/deferred-manifest.ts`
- `extensions/multi-agent/embedded-runner.ts`
- `extensions/wiki-rag/client.ts`
- `electron-agent/src/features/visual/VisualCard.tsx`
- `electron-agent/src/features/tools/ContextToolGroup.tsx`
- `electron-agent/electron-builder.yml`
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

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
