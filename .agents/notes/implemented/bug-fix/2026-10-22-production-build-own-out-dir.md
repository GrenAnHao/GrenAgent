# Agent Note: 开着 dev 也能打包：生产构建写 out-pkg，文件服务不碰 .asar 归档

Status: implemented

## Problem

本机开着 `npm run dev`（或 `npm run start`、已装的 GrenAgent）时打包会冲突，原因有两条，互不相干。

### 一、构建产物共用目录

`dev`、`start`（localrun）和 `build` 都写 `electron-agent/out/main`、`out/preload`；`start` 和 `build` 都写 `dist/`。10-14 起生产主进程的文件名钉回了 `main.js`（[打包硬约束](../../implemented/architecture/2026-09-11-packaging-constraints.md)），两套产物同名不同格式：dev 是 ESM、依赖外置、删掉 `out/main/package.json`；build 是 CJS 字节码桩 + `.jsc`、依赖全打进去、写 `{"type":"commonjs"}`。

build 清空重写 `out/main` 后，正在跑的 dev 下次拉起 `agent-host.js` / `pi-worker.js` 或懒加载 chunk 时读到另一套格式。反过来，build 之后、package 之前只要起过 dev 或 start，`out/main` 就变回 ESM、`package.json` 被删，electron-builder 照样打包，安装包一启动就崩（`require is not defined in ES module scope`）。旧笔记只写了「同一个工作区里两者不要同时跑」。

### 二、Electron 的 fs 把工作区里的 .asar 打开后一直占着

修完第一条后实跑 `npm run package`，在清理 `release/win-unpacked` 时报 `EBUSY: resource busy or locked, unlink '...\release\win-unpacked\resources\default_app.asar'`。用 Restart Manager 查占用者：是正在运行的 dev 主进程（`electron.exe .`），`app.asar` 也被它占着，而它的 exe 和这两个文件毫无关系。

在 Electron 主进程里对一个 `.asar` 文件只做一次 `fs.promises.lstat` 或 `stat`：返回 `isDirectory: true`，文件随即被这个进程占用，同进程里 `unlink` 报 `EBUSY`；换成 `original-fs` 做同样的 `lstat`，返回 `isDirectory: false`，没有占用，`unlink` 成功（探针 `asar-lock-probe.main.cjs`，结果 `asar-lock-probe.txt`）。Electron 的 asar 补丁会打开归档并缓存句柄，直到进程退出。

主进程里遍历用户工作区的是 `FileService`：输入框 `@` 文件选择用的 `get_file_tree`（`buildTree`，深 6 层，跳过名单里没有 `release`）和文件浏览器的 `list_dir`（给文件条目 `stat` 取大小）。工作区是 Pi 仓库根时，`electron-agent/release/win-unpacked/resources/app.asar` 正好第 5 层，列一次树就被占住；`buildTree` 还把它当目录往里递归。

## Decision

### 生产构建写 out-pkg，打包时映射回原布局

`electron.vite.config.ts` 里 `production`（`command === "build"` 且不是 localrun）时三段输出改到 `out-pkg/`：main → `out-pkg/main`，preload → `out-pkg/preload`，renderer → `out-pkg/renderer`。dev 和 localrun 仍写 `out/`、`dist/`。`copy-pi-adjacent-assets` 插件按当前模式的 main 输出目录拷资源、写或删 `package.json`。

`electron-builder.yml` 的 `files` 不再收 `out/**`、`dist/**`，改用 FileSet：`out-pkg/main` → `out/main`、`out-pkg/preload` → `out/preload`、`out-pkg/renderer` → `dist`。asar 内的布局和以前一样，`package.json` 的 `main`、`workerEntry.ts` 的打包态路径、`resolveRendererHtml`、preload 的相对路径都不改。

`asarUnpack` 按**源路径**匹配：app-builder-lib 26.15.3 的 `AsarPackager.isUnpacked` 把源文件相对 appDir 的路径交给 filter，所以模式写 `out-pkg/main/...`；解包后落在 `app.asar.unpacked/out/main/...`。写成 `out/main/...` 一条都对不上，子进程入口会留在 asar 里起不来，`sourceCodeProtection.test.ts` 断言 `asarUnpack` 里没有 `out/` 开头的模式。

### FileService 用不带 asar 补丁的 fs

新增 `electron/app/rawFs.ts`：Electron 进程里用 `createRequire(import.meta.url)('original-fs')`，普通 Node（vitest、脚本）里退回 `node:fs`。`fileService.ts` 的所有 fs 调用（含 `existsSync`）改走它。工作区里的 `.asar` 在文件树和文件浏览器里显示成普通文件，不再被当目录展开，也不再被占用。`rawFs.test.ts` 断言 `fileService.ts` 不直接 import `node:fs`。

### 涉及文件

- `electron-agent/electron.vite.config.ts`
- `electron-agent/electron-builder.yml`
- `electron-agent/.gitignore`（加 `out-pkg/`）
- `electron-agent/electron/app/rawFs.ts`、`rawFs.test.ts`
- `electron-agent/electron/app/fileService.ts`
- `electron-agent/electron/app/sourceCodeProtection.test.ts`
- `electron-agent/electron/agent/copyPiAdjacentAssets.test.ts`
- `docs/architecture.md`

## Alternatives considered

- **产物换目录 + `extraMetadata.main` 指向 `out-pkg/main/main.js`**（和用户确认方向时的说法）。最强理由：直观，asar 里看到的就是 `out-pkg`，不用理解 FileSet 映射。不用：asar 内路径一变，`workerEntry.ts` 的 `app.asar.unpacked/out/main`、`mainConfig.ts` 的 `dist/index.html` 和对应测试都要改，运行时多出一处 dev / 打包分叉；FileSet 映射在打包那一步换回原路径，运行时零改动，目录分开的效果相同。
- **专门在一个 git worktree 里打包**。最强理由：一行代码不改。不用：多维护一份 `node_modules`，主仓里照样能误跑 `npm run build && npm run package`；第二条（asar 被占）在 worktree 的 `release/` 里一样会发生，只要那个 worktree 被打开过。
- **package 前检查 `out/main` 是不是生产产物，不对就报错**。最强理由：改动最小。不用：只拦住打出坏包，dev 开着时 build 换掉 dev 的 `out/main` 这一半还在。
- **只让 dev 换目录**（dev 写 `out-dev/`）。不用：`package.json` 的 `main` 是 dev / localrun 的入口，`electron-vite preview` 也按它找；改 dev 就得改 `main`，再用 `extraMetadata` 给打包改回去。
- **asar 那条：把 `release`、`out-pkg` 加进 FileService 的跳过名单**。最强理由：一行改动，文件树里也少了噪声。不用：只躲开本仓库的目录名，用户别的项目里的 `.asar`（或别的路径下的打包产物）照样被占；而且 `release` 在别的项目里可能是正经源码目录。
- **asar 那条：主进程 `process.noAsar = true`**。不用：全局关掉 asar 支持，打包版自己从 `app.asar` 读资源会受影响，波及面远大于一个服务。

## Consequences

- 本机可以开着 dev / start 跑 `npm run build && npm run package`：build 只写 `out-pkg/`，dev 的 `out/`、`dist/` 一个字节不动；dev / start 也不再能把待打包的产物换成 ESM。代价是磁盘上多一份产物（`out-pkg/` 约 30MB 量级），`asarUnpack` 的写法和 asar 内路径不再字面一致，靠注释和测试说明。
- 本地脚本（`scripts/agent-host-smoke.mjs` 等）默认 `--entry out/main/...`，拿的是 dev 产物；要测生产产物得显式传 `out-pkg/main/...`。
- 改完 FileService 之前就在跑的 GrenAgent / dev 进程仍占着当时列到的 `.asar`，要重启一次才释放；本次实跑时 `release/win-unpacked` 就是这样被占着的，验证改用临时输出目录打包。
- FileService 之外仍用 `node:fs` 的代码（agent-host 里 pi 的 `ls` / `read` 等工具、CodeGraph 子进程）碰到工作区里的 `.asar` 会有同样的问题，本次没改；本次实测的占用者只有主进程。
- 文件树里 `.asar` 从「可展开的目录」变成普通文件，这是有意的行为变化。
- electron-builder 若改成按目标路径匹配 `asarUnpack`，`out-pkg/main/...` 会全部失效；升级 electron-builder 后要核对 `app.asar.unpacked/out/main` 里还有子进程入口。

## Verification

结果：通过（命令实跑；仓库没有 `verify-*` skill）。证据在 `.agents/evidence/2026-10-22-production-build-own-out-dir/`。

- `cd electron-agent && npx vitest run electron/app/rawFs.test.ts electron/app/fileService.test.ts electron/app/sourceCodeProtection.test.ts electron/agent/copyPiAdjacentAssets.test.ts electron/agent/workerEntry.test.ts electron/main.config.test.ts electron/agent/codemodeWorkerBuild.test.ts electron/ipc/register.test.ts`：8 个文件 61 条通过（`vitest.txt`）。
- dev 实例（本会话的宿主，`electron.exe .`，从 `out/main` 起的 agent-host / agentdata-host）全程在跑。`npm run build` 两次前后 `out/main/main.js`、`out/main/agent-host.js`、`out/preload/preload.js`、`dist/index.html` 的 sha256 和 mtime 都不变（`dev-out-before.txt`、`dev-out-after.txt`）；`out-pkg/main/main.js` 是字节码桩（`require("./bytecode-loader.cjs"); require("./main.jsc")`），旁边有 `{"type":"commonjs"}`，`chunks/` 89 个文件（`after-build.txt`）。
- 第一次 `npm run package`（输出到 `release/`）在清理 `release/win-unpacked` 时 EBUSY（`package.log` 首次失败已被第二次覆盖，报错原文见本笔记 Problem），占用者是 dev 主进程 pid 24896；`asar-lock-probe.txt` 复现了「Electron fs 对 .asar 做一次 lstat / stat 就占住、original-fs 不会」。
- 因 `release/win-unpacked` 被修复前启动的 dev 进程占着，改用 `npx electron-builder --config electron-builder.yml -c.directories.output=%TEMP%\grenagent-pkg-verify` 打包：退出码 0，产出 NSIS 安装包（`package.log`）。asar 里有 `out/main/main.js`、`main.jsc`、`package.json`、`out/preload/preload.js`、`dist/index.html`，没有任何 `out-pkg` 路径；`app.asar.unpacked/out/main/` 下有 `agent-host.js`、`package.json`、`pi-job-guard.exe`、`chunks/`（`asar-contents.txt`）。
- 启动这份 `win-unpacked/GrenAgent.exe`（临时 `--user-data-dir`，25 秒）：主进程、GPU、网络、渲染进程、两个 RunAsNode 子进程（agent-host、agentdata-host）、从 `app.asar.unpacked\out\main\` 起的 `pi-job-guard.exe`、用户配置的 MCP server 都在（`packaged-run.processes.txt`）；stderr 有 12 行 `extension loaded`，没有 `Cannot find module` / `ERR_PACKAGE` / `require is not defined` / `failed to start`，只有打包硬约束笔记里已知的 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`（`packaged-run.stderr.txt`）。`taskkill /T` 后该目录下无残留进程。
- 没验证：没有重启 dev 去确认新 FileService 在真实界面里不再占住 `.asar`（会断掉本会话的宿主），这一点靠 `asar-lock-probe` 对 `original-fs` 的实测和 `rawFs.test.ts` 的源码断言；没有跑 `npx electron-vite build --mode localrun`，因为它会重写正在运行的 dev 实例用的 `out/`，localrun / serve 的输出目录由 `sourceCodeProtection.test.ts` 断言；没有跑 NSIS 安装程序。
