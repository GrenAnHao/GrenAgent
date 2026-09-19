# GrenAgent 源码保护（V8 字节码 + ASAR 完整性）

- 日期：2026-09-17
- 状态：规格已按头脑风暴裁决写完，可进 writing-plans
- 主题：按 [electron-vite 源码保护](https://cn.electron-vite.org/guide/source-code-protection) 给生产包加主进程字节码和 ASAR 完整性；预加载与渲染层不编，窗口沙箱保持开启。

> **裁决记录（2026-09-17）**
>
> - **范围 = 方案 B：** 主进程（`main` + `pi-worker`）字节码 + ASAR 完整性。预加载不编。`sandbox: true` 保持。
> - **`OnlyLoadAppFromAsar`：** 开启。该 fuse 只禁止用明文 `app/` 目录顶替 `app.asar`，不禁止 `asarUnpack` 与显式 spawn 的 worker。
> - **`runAsNode`：** 不关闭。子代理依赖 `ELECTRON_RUN_AS_NODE=1`。
> - **worker：** 编字节码；加载器与 `pi-worker.jsc` 必须解包。不改成 `utilityProcess`，worker 不解进 asar 做完整性校验。
> - **不做：** `protectedStrings`、预加载字节码、关 sandbox、渲染层混淆、关 `--inspect` / `NODE_OPTIONS`、一次构建多架构。
>
> **实现期裁决（2026-09-17）：`transformArrowFunctions: false`。** 生产构建编字节码时，Babel 无法转换 class 字段里的箭头（第一方已把 `DapClient.resolveInitialized` 改成 constructor 赋值；下一处是依赖 undici `PoolBase` 的 `[kOnConnect] = (...) => {}`）。不改 `node_modules`、不拆 vendor chunk。`bytecode` 写成 `{ transformArrowFunctions: false }`，其余默认（`removeBundleJS: true`、不限 `chunkAlias`）。文档称异步箭头可能运行时崩溃，靠 `electron-vite build` 产出 `.jsc` 后的启动冒烟确认，不在本规格里关字节码。

> **审查修正（2026-09-17，对照仓库代码与上游源码复核）**
>
> 1. **字节码只在 CJS 产物上生效（必须修复，见 §2）。** `electron-agent/package.json` 保持 `"type": "module"`（Pi SDK 只有 `exports.import`，`electron-vite serve` 打成 CJS 会 `require` 失败）。生产构建用 `defineConfig(({ command }) => …)` 在 `command === "build"` 时显式 `output.format: "cjs"` 并写入 `out/main/package.json` `{"type":"commonjs"}`。字节码插件仅在 `output.format === 'cjs'` 时工作，否则只打一条 warning 就跳过——构建照样成功，产物仍是明文 ESM。
> 2. **必须解包 `out/main/bytecode-loader.cjs`（必须修复，见 §4）。** 入口存根内容是 `require("./bytecode-loader.cjs")` + `require("./<name>.jsc")`，loader 是独立文件；worker 跑在 `ELECTRON_RUN_AS_NODE` 下读不到 asar，缺它则子代理启动即崩。
> 3. **主进程 chunk 的 `.jsc` 也在 asar 外（措辞修正 + 记为残留风险，见 §4）。** `out/main/chunks/**` 已整目录解包，而 main 依赖其中的 chunk，「完整性校验罩得到主进程」只对入口存根成立。
> 4. **复核无误、维持原判的部分：** fuse 键名用 camelCase（核对 `app-builder-lib/src/options/FuseOptionsV1.ts`，electron-vite 文档里的 PascalCase 示例不适用于 electron-builder）；`asar.disableIntegrity` 禁忌；`removeBundleJS` / `protectedStrings` 默认值；`sandbox: true`（`mainConfig.ts:27`）与既有 `main.config.test.ts` 断言；`resolveWorkerEntry` 与 `workerEntry.test.ts`；`electron-builder.yml` 现状；仓库已有 `yaml` 解析用法（`copyPiAdjacentAssets.test.ts:36`）；`afterPack` 只写 `app.asar.unpacked`，不影响 asar 哈希。`transformArrowFunctions` 已由实现期裁决改为 `false`（见上）。

## 1. 目标

生产安装包里，主进程与子代理入口目前是明文 JS，拆 asar 或替换 `app/` 即可读、可改。electron-vite 6 已支持 `build.bytecode`；Electron 38 在 Windows / macOS 上支持 ASAR 完整性 fuse。

改完之后：

1. `electron-vite build` 把主进程两个入口及其 JS chunk 编成 V8 字节码（`.jsc`），入口文件替换成两行 `require` 的存根，另产出共用的 `bytecode-loader.cjs`。
2. 打包后的 Electron 校验 `app.asar` 哈希，且只从 `app.asar` 加载应用入口。
3. 预加载仍是明文，窗口继续 `sandbox: true`。
4. 子代理仍用现有 `spawn(execPath, [pi-worker.js])` + `ELECTRON_RUN_AS_NODE=1` 启动，加载的是字节码而非源码。
5. `electron-vite dev` 行为不变，开发态仍是明文 JS。

### 成功标准

1. `electron.vite.config.ts` 在 `command === "build"` 时 `main.build.bytecode` 为 `{ transformArrowFunctions: false }`（不要布尔 `true`，也不要加 `protectedStrings` / `chunkAlias`），`main.build.rollupOptions.output.format` 为 `"cjs"`，且 `out/main/package.json` 为 `{"type":"commonjs"}`（§2 备选 A）；`command === "serve"` 时 main **不**设 `bytecode`、**不**设 `format: "cjs"`。`preload` 与 `renderer` 的 `build` 不含 `bytecode`。
2. `browserWindowOptions.webPreferences.sandbox` 仍为 `true`。
3. `electron-builder.yml` 含 `electronFuses.enableEmbeddedAsarIntegrityValidation: true` 与 `onlyLoadAppFromAsar: true`；未设置 `runAsNode: false`；未设置 `asar.disableIntegrity`。
4. `asarUnpack` 含 `out/main/pi-worker.js`、`out/main/pi-worker.jsc`、`out/main/bytecode-loader.cjs`，不含 `out/main/main.jsc`。
5. `resolveWorkerEntry` 打包分支仍指向 `app.asar.unpacked/out/main/pi-worker.js`。
6. `pnpm test` 覆盖 §7 的配置断言。

### 非目标

- 不给预加载 / `webviewPreload` / 渲染层编字节码。
- 不把 `sandbox` 设为 `false`。
- 不配置 `protectedStrings`（密钥在用户设置里，源码无硬编码密钥清单）。
- 不关 `runAsNode`，不加关 `--inspect`、关 `NODE_OPTIONS`、cookie 加密等其它 fuse。
- 不把子代理改成 `utilityProcess`，不把 `pi-worker.jsc` 留在 asar 内。
- 不为完整性校验收窄 `out/main/chunks/**` 解包规则（chunk 名带 hash，且目录里还有 `pi-sandbox-win.exe` / `runner.py`）；主进程 chunk 的 `.jsc` 在 asar 外，作为残留风险接受。
- 不引入 `beforeBuild` / `ELECTRON_EXEC_PATH` 一次打多架构。
- 不改 CLI 包、不改已移除的 tauri-agent。
- 不把完整 `electron-vite build` / `pnpm package` 放进每次 `pnpm test`。

## 2. 字节码（主进程）

electron-vite 6（当前 `^6.0.0-beta.1`）用 `build.bytecode`，不用旧的 `bytecodePlugin`。只在生产构建生效。

`electron-agent/electron.vite.config.ts` 的 `main.build` 在现有 `rollupOptions` 旁增加字节码选项：

```ts
export default defineConfig(({ command }) => {
  const production = command === "build";
  return {
    main: {
      // resolve 不变
      build: {
        ...(production ? { bytecode: { transformArrowFunctions: false } } : {}),
        rollupOptions: {
          input: {
            main: resolve(__dirname, "electron/main.ts"),
            "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
          },
          ...(production ? { output: { format: "cjs" as const } } : {}),
          external: [/* 现有列表不变 */],
        },
      },
    },
    // preload / renderer 不变
  };
});
```

含义：

- 必须写成对象，且**只**含 `transformArrowFunctions: false`。不要用布尔 `true`（那会走 Babel 转箭头，构建会在 undici class 字段上崩）。不要加 `protectedStrings`、不要加 `chunkAlias`（两个入口及其拆出的 JS chunk 都编；`removeBundleJS` 保持默认 `true`）。
- `preload.build` 只保留现有 `rollupOptions`（CJS、`preload` / `webviewPreload` 两个入口），不加 `bytecode`。
- `copy-pi-adjacent-assets` 插件仍在 `main.plugins`：它拷 `runner.py` / `runner.mjs` / `pi-sandbox-win.exe` / `prompts`；生产 `closeBundle` 另外调用 `writeMainCjsPackageJson(out/main)`。
- 第一方 `extensions/dap/client.ts` 的 `resolveInitialized` 不得再用 class 字段箭头初始化（constructor 内赋值），避免同类陷阱出现在自有代码里。

### 输出格式必须是 CJS（硬性前提）

字节码插件在 `configResolved` 里判定 `supported = output.format === 'cjs' && !useInRenderer`；格式为 `es` 时它**只打一条 warning 就跳过**，不产出 `.jsc`、也不报错。也就是说配置写对了但格式没改，构建会成功、产物仍是明文——这是本方案最容易踩的静默失效，必须在成功标准和测试里卡住。

electron-vite 按 `package.json` 的 `type` 决定 main / preload 的输出格式：`type === "module"` 且 Electron 支持 ESM 时为 `es`，否则 `cjs`。根 `package.json` 必须保持 `"type": "module"`：`@earendil-works/pi-coding-agent` 的 `exports` 只有 `import`、没有 `require`。`electron-vite serve` 若把 main 打成 CJS，运行时 `require()` 该包会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，同时 `import.meta` 被替换成 `{}`（`[EMPTY_IMPORT_META]`）。

生产字节码仍要求 CJS。做法是 **§2 备选 A**（不要删根 `"type": "module"`）：

- `defineConfig(({ command }) => …)`：仅 `command === "build"` 时设 `output.format: "cjs"` 与 `bytecode`；`serve` 保持默认 ESM。
- `closeBundle` 在 `emptyOutDir` 之后往 `out/main` 写 `package.json`：`{"type":"commonjs"}`。最近的上级 package 变成这份文件，Electron 把存根 `main.js` / `pi-worker.js` 当 CJS，`require("./bytecode-loader.cjs")` 才合法。根 `package.json` 仍是 `"type": "module"`，不影响开发态。
- **不要**删根 `"type": "module"` 来换 CJS（落地后 `pnpm dev` 会在加载主进程时崩）。
- **不要**改产物扩展名为 `.cjs`（要同步改 `package.json` 的 `main`、`resolveWorkerEntry`、`asarUnpack`，且 `.jsc` 会变成 `.cjsc`）。

CJS 输出对现有源码无影响：`main.ts` / `mainConfig.ts` 用的 `__dirname` 在 CJS 下是原生变量；`codeGraphEngine.ts` 的 `import.meta.url` 由 Rollup 改写成等价 `__filename` 的形式；`copyPiAdjacentAssets` 依赖的「chunk 内 `import.meta.url` 指向 chunk」在 CJS 下由 `__filename` 同样成立。

preload 已经在配置里显式写了 `output.format: "cjs"`，不受这次改动影响，也不需要跟着编字节码。

开发：`electron-vite dev` 不编字节码。`out/main/main.js` 与 `out/main/pi-worker.js` 仍是完整源码 bundle。

生产：加载器文件名不变（`main.js`、`pi-worker.js`），同目录出现对应 `.jsc`。`package.json` 的 `"main": "out/main/main.js"` 不用改。

字节码绑定构建机上的 Electron V8 与 CPU 架构。要发 Windows / macOS / Linux 包，必须在对应平台上执行 `electron-vite build`，不能把一台机器上的 `.jsc` 拷到另一架构再用。本规格不增加交叉编译钩子。

## 3. ASAR 完整性

`electron-agent/electron-builder.yml` 在现有 `asar: true` 旁增加（与 `asar` 同级，不要包进不存在的 `build:` 根键）：

```yml
electronFuses:
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
```

- `enableEmbeddedAsarIntegrityValidation`：启动时核 `app.asar` 的 SHA-256，缺失或不匹配则退出。Electron 38 在 Windows（≥ 30）与 macOS（≥ 16）可用。
- `onlyLoadAppFromAsar`：应用入口只从 `app.asar` 找，不再回退到旁边的 `app/` 或 `default_app.asar`。native 模块与 `asarUnpack` 路径仍可用。
- **禁止** 写 `runAsNode: false`。子代理 `extensions/multi-agent/runner.ts` 会设 `ELECTRON_RUN_AS_NODE: "1"`。
- **禁止** 写 `asar.disableIntegrity: true`，否则不会写入哈希，完整性 fuse 无效。
- Linux AppImage 官方不做这项校验；配置仍写上，不妨碍打 Linux 包。
- 现有 `asarUnpack`、`afterPack`、`files`、各平台 `target` 除 §4 追加的两条外都不改。`afterPack` 只往 `app.asar.unpacked` 拷贝 codegraph 依赖，不触碰 `app.asar`，不影响哈希。

## 4. pi-worker 解包

子代理是普通 Node 启动路径：操作系统要把 `pi-worker.js` 当真实文件传给 `GrenAgent.exe`。asar 虚拟路径不能当 `argv[1]`。这是既有约束，本规格不改 spawn。

字节码之后，入口文件不再是 bundle，而是两行 `require` 的存根：

```js
"use strict";
require("./bytecode-loader.cjs");   // 注册 .jsc / .cjsc 扩展
require("./pi-worker.jsc");         // 真正的产品代码
```

`.jsc` 由插件按 `chunk.fileName + 'c'` 产出（`.js` → `.jsc`，`.cjs` → `.cjsc`），与原 chunk 同目录同名。因此：

| 文件 | 位置 | 原因 |
| --- | --- | --- |
| `out/main/main.js`（存根）+ `main.jsc` | 留在 `app.asar` | 主进程走 Electron，能读 asar |
| `out/main/pi-worker.js`（存根） | `asarUnpack`（已有） | spawn 入口，必须是真实文件 |
| `out/main/pi-worker.jsc` | **追加** | 存根按同目录读 `.jsc`；`ELECTRON_RUN_AS_NODE` 读不了 asar |
| `out/main/bytecode-loader.cjs` | **追加** | 存根第一行就 require 它；worker 在 asar 外，缺文件则启动即崩 |
| `out/main/chunks/**` | 已整目录解包 | chunk 名带 hash 且目录里还有 `pi-sandbox-win.exe` / `runner.py`，无法收窄；**主进程与 worker 的 chunk `.jsc` 都在这里** |

`electron-builder.yml` 的 `asarUnpack` 在 `out/main/pi-worker.js` 下面追加两行：

```yml
- out/main/pi-worker.jsc
- out/main/bytecode-loader.cjs
```

不要解包 `out/main/main.jsc`。不要改 `resolveWorkerEntry`：打包态仍是 `join(resourcesPath, 'app.asar.unpacked', 'out', 'main', 'pi-worker.js')`。

### 残留风险：解包出去的 `.jsc` 不受完整性保护

解包目录不在 ASAR 哈希里，可以被读走或替换。范围比原先估计的大：

- `pi-worker.jsc`、worker 的 chunk `.jsc`、`bytecode-loader.cjs` —— 子代理侧，全部在 asar 外。
- **主进程的 chunk `.jsc` 也在 asar 外**：`out/main/chunks/**` 整目录已解包，而 `main.js` 依赖其中的 `chunks/extensions-*.js`（实测确认）。受完整性校验的只有入口存根 `main.js` 和 `main.jsc` 本身。

保护仍然只到字节码混淆这一层。要把这些纳入完整性校验，得改 spawn（例如 `utilityProcess`）并收窄解包规则，明确列为非目标；实现计划里需要把「解包目录内容可被替换」写成已知缺口，不要写成已防护。

## 5. 错误处理与运行时

- **字节码静默失效（最需要盯的一条）：** 输出格式不是 CJS 时插件只打一条 warning 就跳过，构建成功但没有 `.jsc`。`pnpm build` 之后必须确认 `out/main/` 下同时存在 `main.jsc`、`pi-worker.jsc`、`bytecode-loader.cjs`，且 `main.js` 只剩两行 `require`——这是一条铁律，不靠肉眼跳过 warning。
- 字节码编译失败（Electron 拉不起来、某 chunk 编译崩溃）：`electron-vite build` 失败，不产出可打包的残缺 `out/`。不在运行时兜底回明文。`removeBundleJS` 默认 `true`：非入口 chunk 直接删除、入口被替换成上面的存根，没有明文 bundle 可回退。
- worker 缺失 `bytecode-loader.cjs` 或 `pi-worker.jsc`：子进程 `require` 抛错退出，子代理不可用，主进程不受影响。靠 §4 的解包规则避免，不做运行时降级。
- ASAR 哈希失败：Electron 直接退出，应用代码看不到这个错误，不必加 try/catch。
- 开发态没有 `.jsc`：`resolveWorkerEntry` 指向明文 `pi-worker.js`，与今天相同。
- `Function.prototype.toString` 在编过的函数上不可用。仓库主进程 / `cli/` 当前没有这种用法；本规格不为此改业务代码。

## 6. 数据流

```text
electron-vite build（生产）
  main + pi-worker bundle
        │
        ▼
  Electron 进程编 .jsc，留下加载器 .js
        │
        ├─ out/main/main.js + main.jsc     → 打进 app.asar
        ├─ out/main/pi-worker.js + .jsc    → asarUnpack
        ├─ out/main/bytecode-loader.cjs    → asarUnpack（追加）
        └─ out/main/chunks/**              → 已有 asarUnpack
                │
                ▼
electron-builder
  写入 asar 完整性哈希
  fuse: EnableEmbeddedAsarIntegrityValidation
        OnlyLoadAppFromAsar
  runAsNode 保持默认开启
                │
                ▼
安装包启动
  Electron 核 app.asar → 加载器 main.js → main.jsc
  子代理 spawn(execPath, [unpacked/pi-worker.js])
        → require("./bytecode-loader.cjs") + require("./pi-worker.jsc")
          （两者都必须在 app.asar.unpacked 里）
```

渲染层 `dist/`、预加载 `out/preload/*.js` 不进入这条链。

## 7. 测试

全部放在现有 Vitest，读仓库里的配置文件，不调用 `electron-vite build`，不做安装包冒烟。

1. 调用 default 导出 `{ command: "build", mode: "production" }`：`main.build.bytecode` 深等 `{ transformArrowFunctions: false }`，且 `main.build.rollupOptions.output.format === "cjs"`。配置文件无副作用。
2. 同一份 build 配置：`preload.build.bytecode` / `renderer.build.bytecode` 为 `undefined`。调用 `{ command: "serve" }` 时 `main.build.bytecode` 为 `undefined`，且 output format 不是 `"cjs"`。
3. `electron-agent/package.json` 的 `"type"` 为 `"module"`；`writeMainCjsPackageJson` 写出 `{"type":"commonjs"}`（备选 A，防止生产存根被根 type:module 当成 ESM）。
4. `browserWindowOptions.webPreferences.sandbox === true`（现有 `main.config.test.ts` 已有，保持）。
5. 解析 `electron-builder.yml`（沿用 `yaml` 依赖与 `copyPiAdjacentAssets.test.ts` 已有的读法）：`electronFuses.enableEmbeddedAsarIntegrityValidation === true`；`electronFuses.onlyLoadAppFromAsar === true`；`electronFuses.runAsNode` 不是 `false`（缺省或 `true` 均可）；`asar.disableIntegrity` 不是 `true`。
6. `asarUnpack` 含 `out/main/pi-worker.js`、`out/main/pi-worker.jsc`、`out/main/bytecode-loader.cjs`，且数组每一项都不等于 `out/main/main.jsc`。
7. `resolveWorkerEntry({ packaged: true, ... })` 仍以 `pi-worker.js` 结尾，路径含 `app.asar.unpacked`（现有 `workerEntry.test.ts` 已有，保持）。

新断言放在邻近测试文件（例如 `electron/app/sourceCodeProtection.test.ts`，或并入现有 builder 配置测试），不要为读 yml 再写一套 parse 工具。

不进 `pnpm test`、但必须写进实现计划手动验证步骤的：

- `pnpm build` 后 `out/main/` 下存在 `main.jsc`、`pi-worker.jsc`、`bytecode-loader.cjs`，且 `main.js` / `pi-worker.js` 只剩两行 `require`（这一条专门抓字节码静默失效）。
- 打包后启动：主进程正常、子代理能 spawn 并跑通一次任务（验证解包三件套齐全）。
- 手动改坏 `app.asar.unpacked` 里的 `pi-worker.jsc`，确认子代理失败而主进程不受影响（确认 §4 的残留风险边界）。

## 8. 文件清单

新增：

- `electron-agent/electron/app/sourceCodeProtection.test.ts`（若并入现有测试文件则可不新增）
- `electron-agent/electron/agent/writeMainCjsPackageJson.ts`（生产 `{"type":"commonjs"}`）

修改：

- `electron-agent/electron.vite.config.ts`（`defineConfig(({ command }) => …)`：生产 `bytecode` + CJS，开发 ESM；`closeBundle` 写 `out/main/package.json`）
- `electron-agent/package.json`（**保留** `"type": "module"`；`main` / `scripts` 不动）
- `electron-agent/electron-builder.yml`（`electronFuses` + `asarUnpack` 追加 `pi-worker.jsc` 与 `bytecode-loader.cjs`）

不改：

- `electron-agent/electron/mainConfig.ts`（sandbox 保持）
- `electron-agent/electron/agent/workerEntry.ts`
- `electron-agent/electron/preload.ts`、`webviewPreload.ts`
- `extensions/multi-agent/runner.ts`
- `package.json` 的 `main` / `scripts`

## 9. 规格自检

- 无「待定 / TODO」占位。bytecode 用 `{ transformArrowFunctions: false }`（仅此键）；fuse 键名与 electron-builder 的 camelCase 一致（已核对 `FuseOptionsV1`，electron-vite 文档里的 PascalCase 示例是给 Forge / `@electron/fuses` 用的，不适用于 `electron-builder.yml`）。
- **CJS 前提已写进 §2、成功标准、测试与手动验证**：字节码在非 CJS 产物上是静默失效而不是报错，规格不能只写「加 bytecode」。
- §2 编 `pi-worker` 与 §4 解包 `.jsc` 不矛盾：编的是字节码，解包的是入口存根加 `.jsc`，两者都不是明文源码（明文 bundle 已被 `removeBundleJS` 删掉 / 替成存根）。
- §3 开启 `onlyLoadAppFromAsar` 与 §4 解包 worker 不矛盾：fuse 管应用入口的搜索路径，不管 `asarUnpack` 上被 spawn 的文件。worker 走 `ELECTRON_RUN_AS_NODE` 且不加载 `app.asar`，两个 fuse 都不作用于它。
- **保护边界写清楚了**：受完整性校验的只有 `app.asar` 内的入口存根与 `main.jsc`；`app.asar.unpacked` 下的 `.jsc`（含主进程 chunk）只到字节码混淆这一层，已列为残留风险而非「已防护」。
- 范围限在 electron-agent 生产构建与打包 fuse，不扩展到渲染层、预加载、子代理进程模型或其它 fuse。
- Linux 无完整性校验已写明，不假装三平台行为相同。
