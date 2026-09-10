# Pi SDK 宿主 · 第 5 份：sidecar 删除与打包清单 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删干净 sidecar / JSONL / spawn 路径，沿用今日 bundle 策略把 extensions 与单份 SDK 打进 `out/main/`，追加 `asarUnpack` 与 `import.meta.url` 相邻资源，让打包后的应用真能跑。**本份完成后主线才可合并。**

**架构：** 今日 sidecar 已是 `bun build --compile` 单文件 bundle（`build-sidecar.mjs:30`），electron-vite 是同一思路，不是新路径。真正工作是：三包 SDK 加为 `electron-agent` 依赖并 `resolve.dedupe`；`@ast-grep/napi` 进依赖并 external；**追加**（不覆盖）已有 `asar` / `@colbymchenry/**` / `afterPack`；把 `runner.py` / `runner.mjs` / `fable-behavior/prompts` 复制到 `out/main/`。禁止方案 B（复制 `../extensions`，会带上 vitest 等 devDeps）。

**技术栈：** electron-builder 26、electron-vite 6、TypeScript、vitest

**规格来源：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md` 的「打包」「验证 · 打包」，以及 review 第四节「第 5 份」全部修正项。

**依赖：** 必须最后执行。第 1–4 份未全部完成时，本份的删除会导致运行时找不到实现。

---

## 前置知识（工作者必读）

### 审查已推翻的旧计划写法（禁止再写）

- **`electron/app/runtimePaths.ts` 不存在。** 只有 `electron/runtimePaths.ts`（`resolvePiProcess` / `resolvePiPackageDir` / `GREN_PI_COMMAND`）。
- **`PI_BIN` 在 electron-agent 无设置项、无 UI。** 它只存在于 `extensions/multi-agent/runner.ts:58`，第 4 份已从 `resolvePiCommand` 删除。本份不要再搜设置页去删「不存在的表单项」。
- **不要**把 `@earendil-works/pi-ai` 标 external 却指望从 `cli/node_modules` 解析——cli 树里 pi-ai **不是顶层**，嵌在 `pi-coding-agent/node_modules` 下，运行期会 `Cannot find module`。
- **不要**写 `files: node_modules/@ast-grep/**` 却不把该包加为 electron-agent 依赖。
- **不要覆盖** `asar: true` / `asarUnpack: node_modules/@colbymchenry/**` / `afterPack: ./scripts/package-codegraph.cjs`。`package-codegraph.cjs:13-15` 依赖 unpacked 路径，覆盖会破坏 CodeGraph。
- **只查动态 import 不够。** 必须处理 `import.meta.url` 相邻资源：`extensions/code-exec/index.ts:16-17`（`runner.py` / `runner.mjs`）、`extensions/fable-behavior/loader.ts:7`（`prompts/`）。
- **禁止方案 B** 复制 `../extensions`：会带上 `extensions/node_modules`（vitest / rolldown / lightningcss `.node` 等 devDeps），与今日 bundle 策略相反。
- 「三条阻断项（extensions / extensions/node_modules / cli SDK 无进包路径）」定性偏差。应改为：**沿用 bundle，处理两套 SDK 副本 + `import.meta.url` 资源 + `@ast-grep/napi` 依赖。**

### 今日打包结构（权威，动手前对照文件）

```yaml
# electron-agent/electron-builder.yml
directories:
  output: release          # 不是 dist/
files:
  - dist/**
  - out/**
  - package.json
asar: true
asarUnpack:
  - node_modules/@colbymchenry/**
afterPack: ./scripts/package-codegraph.cjs
extraResources:
  - from: resources/pi
    to: pi
```

`electron.vite.config.ts` 的 `main.external` **已有** `@homebridge/node-pty-prebuilt-multiarch` 与 `@colbymchenry/codegraph`。第 4 份已把 `input` 改成 `{ main, pi-worker }`。本份只追加，不删这两项。

生产依赖由 electron-builder 按 `package.json` 的 `dependencies` 自动带入，不必把 `node_modules/@ast-grep/**` 写进 `files`。

### 两套 SDK 副本（必须合成一份）

| 位置 | 顶层包 |
| --- | --- |
| `cli/node_modules/@earendil-works` | 只有 `pi-coding-agent`；`pi-ai` / `pi-agent-core` 嵌套其下 |
| `extensions/node_modules/@earendil-works` | 三包均 `0.85.1` |
| `electron-agent/package.json` | **无** pi 包（第 1 份故意不加） |

extensions 源码静态 import `pi-ai`×6、`pi-agent-core`×1，动态 `pi-ai/compat`×2（`llm.ts:78`、`summarize.ts:74`，均为静态字面量）。两份 `pi-ai` 会造成 `resetApiProviders` / `registerProvider` 进程级注册表分裂。

本份：三包加为 `electron-agent` 依赖（`^0.85.1`），vite `resolve.dedupe` 三包，**bundle 进 `out/main/`，不要 external SDK。**

### `@ast-grep/napi`

cli 与 extensions 都是 `^0.43.0`。必须加为 `electron-agent` 的 **dependencies**（不是 devDependencies），并列入 `external` + `asarUnpack`。原生 `.node` 不能打进 bundle。

### `import.meta.url` 相邻资源

bundle 后 `import.meta.url` 指向 `out/main/main.js` 或同目录的 `pi-worker.js`。必须把下列文件复制到 `out/main/`（同一份即可服务两个 chunk）：

| 源 | 目标 |
| --- | --- |
| `extensions/code-exec/runner.py` | `out/main/runner.py` |
| `extensions/code-exec/runner.mjs` | `out/main/runner.mjs` |
| `extensions/fable-behavior/prompts/` | `out/main/prompts/`（含 `tier1/` `tier2/` `tier3/` `modes/`） |

`runner.py` 会交给外部 Python `spawn`，asar 虚拟路径经常失败。把它和 `runner.mjs` 一并 `asarUnpack`。`prompts/` 只 `readFileSync`，asar 可读；为省事也可一起 unpack。

### 类型检查门槛（第 1 份已改）

`tsc -p tsconfig.json` 是 solution-style **空转**。本份一律：

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit
```

第 1 份记下的 **BASELINE ~40** 条既有错误（`electron/` 与 `cli/src/*.test.ts`）在本份收尾修掉，或确认删除 sidecar 后自然消失。触及文件零新增错误。

### 第 3、4 份之后仍在的 sidecar 残骸

| 残骸 | 处理 |
| --- | --- |
| `electron/pi/client.ts` + `jsonl.ts` + `manager.ts` | 本份删除；`eventAdapter.ts` **保留** |
| `electron/pi/systemWorkerManager.ts` | **保留**（第 3 份已改短调用，对外 API 不变） |
| `electron/runtimePaths.ts` | 本份删除（只服务 `pi.exe` / Bun） |
| `main.ts` 的 `resolvePiProcess` / `piCommand` / `PI_PACKAGE_DIR` | 本份删除 |
| `mcpPolicyService.ts` 的 `piCommand` | 本份删除（probe 已是第 3 份进程内调用） |
| `cli/src/runtime.ts` 的 `runRpcMode` / `oneshot` / `probe-*` **子命令入口** | 本份删除；**模块本身保留**供 import |
| `scripts/build-sidecar.mjs`、`build:sidecar`、`resources/pi` | 本份删除 |

`PiClientMetadata` 若第 3 份后仍被 `piRuntimeService.ts` import，把类型搬到 `electron/pi/eventAdapter.ts` 或就地内联，**不要**为了一个 type 留着 `client.ts`。

### 测试与产物路径

| 包 | 命令 |
| --- | --- |
| `cli/` | `cd cli && node --import tsx --test "src/**/*.test.ts"` |
| `electron-agent/` | `cd electron-agent && npx vitest run` |
| `extensions/` | `cd extensions && npx vitest run` |
| 打包 | `cd electron-agent && npm run package` |
| 产物 | `electron-agent/release/win-unpacked/`（`directories.output` 是 `release`，**不是** `dist/`） |

`tauri-agent/` 不在范围内，残留 sidecar 字样保持原样。

---

## 文件结构

**删除：**

| 文件 | 原因 |
| --- | --- |
| `electron-agent/electron/pi/client.ts` + `.test.ts` | JSONL 客户端 |
| `electron-agent/electron/pi/jsonl.ts` + `.test.ts` | 行缓冲 |
| `electron-agent/electron/pi/manager.ts` + `.test.ts` | sidecar spawn |
| `electron-agent/electron/runtimePaths.ts` + `.test.ts` | `pi.exe` / Bun 解析 |
| `electron-agent/scripts/build-sidecar.mjs` | sidecar 构建 |
| `electron-agent/resources/pi/**` | 打包进包的二进制 |

**保留：** `electron-agent/electron/pi/eventAdapter.ts`、`systemWorkerManager.ts`（短调用壳）、`cli/src/probe-models.ts`、`extensions/_shared/oneshot.ts`、`extensions/mcp/probe.ts`。

**修改：**

| 文件 | 改动 |
| --- | --- |
| `electron-agent/package.json` | 加三包 SDK + `@ast-grep/napi`；删 `build:sidecar` |
| `electron-agent/electron.vite.config.ts` | `dedupe`、追加 external、复制相邻资源 |
| `electron-agent/electron-builder.yml` | 删 `extraResources`；**追加** asarUnpack |
| `electron-agent/electron/main.ts` | 去掉 `resolvePiProcess` / `piCommand` / 临时 `PiRuntimeService` |
| `electron-agent/electron/app/mcpPolicyService.ts` | 去掉 `piCommand` |
| `electron-agent/electron/app/piRuntimeService.ts` | 去掉对 `PiClient` / `PiClientMetadata` 的 import |
| `cli/src/runtime.ts` | 删桌面子命令分支，保留 `main()` print 路径 |
| `docs/architecture.md` | sidecar 改为进程内嵌 |

---

## 任务 1：删除 PiClient / JSONL / sidecar manager

**文件：**
- 删除：`electron-agent/electron/pi/client.ts`、`client.test.ts`、`jsonl.ts`、`jsonl.test.ts`、`manager.ts`、`manager.test.ts`
- 修改：任何仍 import 它们的文件（第 3 份后理论上只剩类型）
- 保留：`eventAdapter.ts`

- [ ] **步骤 1：确认无业务引用**

```bash
cd electron-agent && rg -n "from ['\"].*/(client|jsonl|manager)['\"]|PiClient|spawnPiClient|JsonlBuffer" electron --glob '*.ts'
```

预期：只命中即将删除的文件本身，以及 `piRuntimeService.ts` 若仍 import `PiClientMetadata`。`AgentDataClient`（`electron/agentData/client.ts`）**不是** PiClient，不要删。

若 `main.ts` / `PiRuntimeService` 仍 `new PiManager` 或 `client.send`，**停下来**——第 1–4 份有遗漏，回去补完再继续。

- [ ] **步骤 2：搬走 `PiClientMetadata`（若还在）**

若 `piRuntimeService.ts` 仍需要该类型，把它拷到 `eventAdapter.ts` 并改 import。字段保持今日形状（`sessionId?` / `sessionPath?` / `source?`）。不要发明新信封。

- [ ] **步骤 3：删除文件**

```bash
git rm electron-agent/electron/pi/client.ts electron-agent/electron/pi/client.test.ts \
  electron-agent/electron/pi/jsonl.ts electron-agent/electron/pi/jsonl.test.ts \
  electron-agent/electron/pi/manager.ts electron-agent/electron/pi/manager.test.ts
```

- [ ] **步骤 4：类型检查驱动清理**

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 \
  | rg "pi/client|pi/jsonl|pi/manager|PiClient|JsonlBuffer|spawnPiClient"
```

预期：空。其余既有 BASELINE 错误先记下，任务 7 再清。

- [ ] **步骤 5：跑测试**

```bash
cd electron-agent && npx vitest run --project main
```

预期：PASS。`eventAdapter.test.ts` 仍在且通过。已删除文件的测试不再出现。

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "refactor(electron): remove PiClient JSONL transport and sidecar manager"
```

---

## 任务 2：清理 sidecar 命令注入点

**文件：**
- 修改：`electron-agent/electron/app/mcpPolicyService.ts`、对应测试
- 修改：`electron-agent/electron/main.ts`
- 删除：`electron-agent/electron/runtimePaths.ts`、`runtimePaths.test.ts`

**不要**创建或修改不存在的 `electron/app/runtimePaths.ts`。**不要**在设置 UI 里找 `PI_BIN`。

- [ ] **步骤 1：列出引用**

```bash
rg -n "piCommand|resolvePiProcess|resolvePiPackageDir|GREN_PI_COMMAND|GREN_BUN_COMMAND|pi\.exe|processCommand" \
  electron-agent/electron --glob '*.ts'
```

把结果当清单。今日已知：`main.ts:80,87,212-224,278,289,367`、`mcpPolicyService.ts:16,56`、`runtimePaths.ts` 全文。第 3 份应已把 `refreshModelRegistry` / oneshot / probe 改成进程内；若 `main.ts:278` 仍 `new PiRuntimeService({...}).refreshModelRegistry()`，本步骤删掉，改为 `modelRuntimeHost.refresh()`（第 3 份任务 3 已要求；这里是兜底）。

- [ ] **步骤 2：改 `mcpPolicyService` 测试（先红）**

打开 `mcpPolicyService.test.ts`，所有 `piCommand: { command: ... }` 构造参数删掉。先改测试再改实现。

追加：

```ts
it("构造时不需要 piCommand", () => {
  const service = new McpPolicyService({
    // 与文件里其它用例相同的必需字段，唯独没有 piCommand
  });
  expect(service).toBeDefined();
});
```

- [ ] **步骤 3：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/app/mcpPolicyService.test.ts`
预期：FAIL（实现仍要求 `piCommand`，或测试构造已不传但实现仍读取）。

- [ ] **步骤 4：删 `piCommand` 字段与使用点**

`mcpPolicyService.ts` 去掉 `piCommand?: PiProcessCommand` 以及 `this.options.piCommand` 拼 argv 的分支。probe 必须走第 3 份的进程内 `probeServer` + `writeToolsCacheEntry`。若本步骤发现它仍 `spawn(pi.exe)`，改成 import 第 3 份的函数，**不要**再接一条 sidecar。

`main.ts` 去掉 `piCommand: piProcess` 注入。

- [ ] **步骤 5：删 `runtimePaths.ts`**

`main.ts` 去掉 `resolvePiProcess` / `resolvePiPackageDir` / `PI_PACKAGE_DIR` / `processCommand` / `agentDir`（若仅服务 sidecar）。`PI_PACKAGE_DIR` 在 SDK 只用于主题查找（`config.js:311-321`）；交互路径的 `SessionUiAdapter.theme` 已是 stub，worker 路径走 `applyOfficialMainPackageDir`。

```bash
git rm electron-agent/electron/runtimePaths.ts electron-agent/electron/runtimePaths.test.ts
```

- [ ] **步骤 6：扫 `PI_BIN`（确认第 4 份已删，不要编设置项）**

```bash
rg -n "PI_BIN" cli extensions electron-agent --glob '*.{ts,tsx,json}' -g '!node_modules'
```

预期：零业务命中。若 `runner.ts` 仍有，回第 4 份补删。

- [ ] **步骤 7：验证**

```bash
cd electron-agent && npx vitest run --project main
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 \
  | rg "runtimePaths|piCommand|resolvePiProcess|GREN_PI_COMMAND"
```

预期：测试 PASS；rg 空。

- [ ] **步骤 8：Commit**

```bash
git add -A
git commit -m "refactor(electron): drop sidecar process resolution and piCommand injection"
```

---

## 任务 3：删除 sidecar 构建产物与桌面子命令入口

**文件：**
- 删除：`electron-agent/scripts/build-sidecar.mjs`
- 修改：`electron-agent/package.json`、`electron-agent/electron-builder.yml`
- 修改：`cli/src/runtime.ts`
- 删除：`electron-agent/resources/pi/**`（若仓库跟踪了该目录）

- [ ] **步骤 1：删构建脚本与 npm script**

```bash
git rm electron-agent/scripts/build-sidecar.mjs
```

从 `electron-agent/package.json` 的 `scripts` 删除 `"build:sidecar": "node scripts/build-sidecar.mjs"`。

```bash
rg -n "build:sidecar|build-sidecar" --glob '!node_modules' electron-agent cli docs
```

其它 script 不得再依赖它。`docs/superpowers/**` 历史文档不要改。

- [ ] **步骤 2：删 `extraResources`**

从 `electron-builder.yml` **只删**这两行（或整个 `extraResources` 块，若里面只剩 `resources/pi`）：

```yaml
extraResources:
  - from: resources/pi
    to: pi
```

**不要动** `asar` / `asarUnpack` / `afterPack` / `files`。asarUnpack 追加是任务 4。

- [ ] **步骤 3：删 `cli/src/runtime.ts` 的桌面子命令分支**

删除（行号以实施时文件为准，按标识符找）：

- `argv[0] === "probe-mcp"` 分支
- `argv[0] === "probe-models"` 分支
- `argv[0] === "oneshot"` 分支
- `isRpcMode(argv)` 整个分支与 `isRpcMode` 函数
- 随之无用的 import：`runRpcMode`、以及仅被这些分支使用的符号

**保留：** `emitReadyBanner`、`applyOfficialMainPackageDir`、尾部 `main(argv, { extensionFactories: allExtensions })`。`probe-models.ts` / `oneshot.ts` / `mcp/probe.ts` **文件保留**。

- [ ] **步骤 4：验证 cli**

```bash
cd cli && node --import tsx --test "src/**/*.test.ts"
```

预期：PASS。`pi-worker` 仍走 `main()`，不受影响。

- [ ] **步骤 5：删 `resources/pi`**

```bash
# 若目录被 git 跟踪
git rm -r electron-agent/resources/pi
# 若只是构建产物
rm -rf electron-agent/resources/pi
```

`resources/` 下若还有别的文件，只删 `pi` 子目录。

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "build: remove sidecar binary, extraResources, and desktop rpc/oneshot/probe CLI entries"
```

---

## 任务 4：单份 SDK、原生模块、相邻资源（本份核心）

沿用 bundle。**不要**走「复制 `../extensions`」的方案 B。

**文件：**
- 修改：`electron-agent/package.json`
- 修改：`electron-agent/electron.vite.config.ts`
- 修改：`electron-agent/electron-builder.yml`
- 创建：`electron-agent/electron/agent/packagingAssets.test.ts`（断言复制清单，不跑完整打包）

- [ ] **步骤 1：加依赖**

在 `electron-agent/` 执行（版本与 cli / extensions 对齐）：

```bash
cd electron-agent && npm install --save \
  @earendil-works/pi-coding-agent@^0.85.1 \
  @earendil-works/pi-ai@^0.85.1 \
  @earendil-works/pi-agent-core@^0.85.1 \
  @ast-grep/napi@^0.43.0
```

确认 `package.json` 的 `dependencies`（不是 `devDependencies`）出现这四项。

确认：

```bash
ls electron-agent/node_modules/@earendil-works
ls electron-agent/node_modules/@ast-grep
```

三包 + napi 都在 electron-agent 自己的 `node_modules` 顶层。

- [ ] **步骤 2：vite `dedupe` + 追加 `external`**

`electron.vite.config.ts` 的 `main` 段改成（保留第 4 份的 `input` 与今日已有的两个 external）：

```ts
import { cpSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

const root = resolve(__dirname);

function copyPiAdjacentAssets(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(resolve(root, "../extensions/code-exec/runner.py"), resolve(outDir, "runner.py"));
  copyFileSync(resolve(root, "../extensions/code-exec/runner.mjs"), resolve(outDir, "runner.mjs"));
  cpSync(resolve(root, "../extensions/fable-behavior/prompts"), resolve(outDir, "prompts"), {
    recursive: true,
  });
}

export default defineConfig({
  main: {
    resolve: {
      dedupe: [
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-agent-core",
      ],
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "electron/main.ts"),
          "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
        },
        external: [
          "@homebridge/node-pty-prebuilt-multiarch",
          "@colbymchenry/codegraph",
          "@ast-grep/napi",
          /^node:/,
        ],
      },
    },
    plugins: [
      {
        name: "copy-pi-adjacent-assets",
        closeBundle() {
          copyPiAdjacentAssets(resolve(__dirname, "out/main"));
        },
      },
    ],
  },
  // preload / renderer 保持原样
});
```

**不要**把三包 SDK 放进 `external`。**不要**删 pty / codegraph。`electron` 由 electron-vite 自己 external，不必手写（若构建警告再补）。

`copyPiAdjacentAssets` 抽到 `electron/agent/copyPiAdjacentAssets.ts` 并导出，便于单测。vite 插件不要再手写一份复制：

```ts
closeBundle() {
  copyPiAdjacentAssets(resolve(__dirname, ".."), resolve(__dirname, "out/main"));
}
```

`__dirname` 是 `electron-agent/`，上一级才是仓库根（函数入参 `repoRoot` 对的是 `extensions/code-exec/runner.py`）。

- [ ] **步骤 3：编写复制清单测试**

`electron-agent/electron/agent/copyPiAdjacentAssets.ts`：

```ts
import { cpSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const PI_ADJACENT_ASSETS = [
  { from: "extensions/code-exec/runner.py", to: "runner.py" },
  { from: "extensions/code-exec/runner.mjs", to: "runner.mjs" },
  { from: "extensions/fable-behavior/prompts", to: "prompts", dir: true },
] as const;

export function copyPiAdjacentAssets(repoRoot: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const asset of PI_ADJACENT_ASSETS) {
    const src = resolve(repoRoot, asset.from);
    const dest = resolve(outDir, asset.to);
    if ("dir" in asset && asset.dir) cpSync(src, dest, { recursive: true });
    else copyFileSync(src, dest);
  }
}
```

测试（用临时目录，不要依赖完整 vite）：

```ts
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyPiAdjacentAssets } from "./copyPiAdjacentAssets.js";

it("把 runner 与 fable prompts 拷到 outDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-assets-"));
  const repoRoot = resolve(__dirname, "../../.."); // electron-agent/electron/agent → 仓库根
  copyPiAdjacentAssets(repoRoot, dir);
  expect(existsSync(join(dir, "runner.py"))).toBe(true);
  expect(existsSync(join(dir, "runner.mjs"))).toBe(true);
  expect(existsSync(join(dir, "prompts/tier1/identity.md"))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
```

`__dirname` 在 vitest 下以实施时实测为准；若测到的 `repoRoot` 不对，改成 `resolve(__dirname, "../../../..")` 直到 `extensions/code-exec/runner.py` 存在。

- [ ] **步骤 4：运行验证失败，再实现，再通过**

运行：`cd electron-agent && npx vitest run --project main electron/agent/copyPiAdjacentAssets.test.ts`
预期：先 FAIL（文件不存在），实现后 PASS。

- [ ] **步骤 5：追加 `asarUnpack`（不覆盖）**

`electron-builder.yml` 的 `asarUnpack` **在现有 `@colbymchenry` 下面追加**：

```yaml
asar: true
asarUnpack:
  - node_modules/@colbymchenry/**
  - node_modules/@ast-grep/**
  - out/main/pi-worker.js
  - out/main/runner.py
  - out/main/runner.mjs
  - out/main/prompts/**
afterPack: ./scripts/package-codegraph.cjs
```

`asar: true` 与 `afterPack` 一行都不能少。**不要**加 `files: node_modules/@ast-grep/**`。**不要**把 `@earendil-works/**` 放进 asarUnpack（SDK 已 bundle）。

- [ ] **步骤 6：构建并检查产物**

```bash
cd electron-agent && npm run build
```

预期：

- `out/main/main.js` 与 `out/main/pi-worker.js` 存在
- `out/main/runner.py`、`out/main/runner.mjs`、`out/main/prompts/tier1/identity.md` 存在
- `main.js` 体积明显大于「只打 electron/」的时期（extensions 被打进去）

单实例抽查（构建后在 electron-agent 目录）：

```bash
node -e "const a=require.resolve('@earendil-works/pi-ai'); const b=require.resolve('@earendil-works/pi-ai'); console.log(a===b, a)"
```

预期：打印 `true` 与 `electron-agent/node_modules/@earendil-works/pi-ai/...`。打包冒烟再用 asar 内 `require.resolve` 复验。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/package.json electron-agent/package-lock.json \
  electron-agent/electron.vite.config.ts electron-agent/electron-builder.yml \
  electron-agent/electron/agent/copyPiAdjacentAssets.ts \
  electron-agent/electron/agent/copyPiAdjacentAssets.test.ts
git commit -m "build(electron): dedupe Pi SDK, unpack native modules, copy import.meta.url assets"
```

---

## 任务 5：打包产物冒烟（失败不得恢复 sidecar）

单元测试证明不了打包。`directories.output` 是 `release`。

- [ ] **步骤 1：打包**

```bash
cd electron-agent && npm run package
```

预期：成功。若 `Cannot resolve` / `Cannot find module`，按缺失项调整任务 4 的依赖 / external / 复制，**不要**把 `extraResources: resources/pi` 加回去。

- [ ] **步骤 2：检查产物结构**

```bash
# Windows
dir electron-agent\release\win-unpacked\resources
dir electron-agent\release\win-unpacked\resources\app.asar.unpacked\out\main
dir electron-agent\release\win-unpacked\resources\app.asar.unpacked\node_modules\@colbymchenry
dir electron-agent\release\win-unpacked\resources\app.asar.unpacked\node_modules\@ast-grep
```

预期：

- **没有** `resources/pi`
- `app.asar.unpacked/out/main/pi-worker.js` 存在
- `app.asar.unpacked/out/main/runner.py` 与 `prompts/` 存在
- `app.asar.unpacked/node_modules/@colbymchenry/` 存在（CodeGraph 未毁）
- `app.asar.unpacked/node_modules/@ast-grep/` 存在

- [ ] **步骤 3：启动打包后的应用**

```bash
electron-agent/release/win-unpacked/GrenAgent.exe
```

预期：能打开窗口、能打开项目。崩溃则看日志里的 `Cannot find module`，回任务 4。

- [ ] **步骤 4：验证交互回合**

打开一个项目，发一条消息。预期：流式回复。同时验证 SDK / 扩展 / `toJsonEvent` / 渲染层形状。

- [ ] **步骤 5：验证 worker 可 spawn**

```bash
cd electron-agent/release/win-unpacked
# Windows PowerShell
$env:ELECTRON_RUN_AS_NODE="1"
.\GrenAgent.exe resources\app.asar.unpacked\out\main\pi-worker.js --mode json -p "hi"
```

预期：JSONL 或明确的模型配置错误，**不应有** `Cannot find module`。

- [ ] **步骤 6：验证子代理**

在应用里触发 `spawn_agent`。预期：子代理执行并返回。这验证第 4 份 `resolveWorkerEntry()` 的打包分支。

- [ ] **步骤 7：验证原生模块与相邻资源**

- ast-tools grep / edit（`@ast-grep/napi`）
- memory 写入与检索（`node:sqlite`）
- code-exec 跑一段 Python / JS（`runner.py` / `runner.mjs`）
- 切到会加载 fable-behavior 的 profile，确认不报 `prompts/...` ENOENT

- [ ] **步骤 8：验证 MCP 孙进程能被收掉**

带 MCP 的项目打开后关闭项目。预期：无残留 MCP 子进程（第 2 份 `disposeMcpManager` + 第 4 份进程组杀）。

- [ ] **步骤 9：记录结果**

任一步失败：**停在本分支修**，禁止加回 sidecar「先发一版」（规格明令禁止双栈中间产品）。

- [ ] **步骤 10：Commit（仅当有脚本/文档补丁）**

冒烟本身通常无代码。若为 asar 路径加了 `code-exec` 的 unpacked 回退，单独 commit：

```bash
git add -A
git commit -m "fix(packaging): resolve code-exec runners from asar.unpacked"
```

---

## 任务 6：文档清理

**文件：**
- 修改：`docs/architecture.md`（总览图与 cli 节仍写 sidecar RPC）
- 创建：`docs/pi-sdk-upgrade-checklist.md`
- 不要改：`docs/superpowers/specs/**`、`docs/superpowers/plans/**`

- [ ] **步骤 1：定位业务文档**

```bash
rg -l "sidecar|runRpcMode|pi\.exe|GREN_PI_COMMAND|PI_BIN|resources/pi" docs --glob '!superpowers/**'
```

- [ ] **步骤 2：改 `docs/architecture.md`**

总览图改为：

```
electron-agent 主进程内嵌 Pi SDK
  → AgentSessionRuntime / ModelRuntime（交互、Goal、短调用）
  → spawn(process.execPath, [PI_WORKER_ENTRY]) + ELECTRON_RUN_AS_NODE（子代理）
```

删除「stdio JSONL RPC（`--mode rpc`）→ cli sidecar → resources/pi」那段。cli 节改为：源码仍在 `cli/`（`gren-runtime` / `pi-sdk` / `pi-worker`），由 electron-vite bundle，不再产出 `pi.exe`。主进程解析顺序改为启动期 `PI_WORKER_ENTRY`（第 4 份），删除 `GREN_PI_COMMAND` → `resources/pi` → Bun 链。

- [ ] **步骤 3：升级检查清单**

`docs/pi-sdk-upgrade-checklist.md`：

```markdown
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
   `asarUnpack` 仍含 `@colbymchenry/**`。

6. **两套副本** —— `electron-agent` 的 `resolve.dedupe` 三包必须仍生效；
   `require.resolve('@earendil-works/pi-ai')` 在主进程与 worker 解析到同一份。
```

- [ ] **步骤 4：Commit**

```bash
git add docs/architecture.md docs/pi-sdk-upgrade-checklist.md
git commit -m "docs: replace sidecar architecture with in-process Pi SDK host"
```

---

## 任务 7：既有类型错误收尾 + 最终验收

第 1 份把 ~40 条既有 `tsc -p tsconfig.node.json` 错误记入本份。删掉 sidecar 后其中一部分会消失（`runtimePaths` / `PiClient`）。剩下的在本任务修到 **零错误**，或把「与本迁移无关、且不挡 `electron/agent/**`」的条目列进 PR，不得默默留下新的。

- [ ] **步骤 1：量当前错误**

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 | rg "error TS"
```

逐条分类：

1. 本迁移引入 → 必须修
2. 删 sidecar 后的死引用 → 必须修
3. 迁移前就有、与宿主无关 → 修掉或在 PR 写明路径与原因

- [ ] **步骤 2：修并复验**

目标：`tsc -p tsconfig.node.json --noEmit` 退出码 0。若某条需要大改无关模块，单独开 follow-up，**不要**用 `// @ts-ignore` 糊弄 `electron/agent/**`。

- [ ] **步骤 3：全仓 sidecar 残留扫描**

```bash
rg -n "resources/pi|build-sidecar|GREN_PI_COMMAND|runRpcMode|PiClient|spawnPiClient" \
  cli extensions electron-agent \
  --glob '*.{ts,tsx,json,yml,mjs,md}' \
  -g '!node_modules' -g '!docs/superpowers/**'
```

预期：零业务命中。`tauri-agent/` 不扫。测试文件里若还写「历史 sidecar」注释，改成「历史 JSONL 宿主」或删掉。

- [ ] **步骤 4：三包测试**

```bash
cd cli && node --import tsx --test "src/**/*.test.ts"
cd ../extensions && npx vitest run
cd ../electron-agent && npx vitest run
```

预期：全 PASS。

- [ ] **步骤 5：规格《验证》对表**

跑：

```bash
cd electron-agent && npx vitest run --project main \
  electron/agent/workspaceIsolation.test.ts \
  electron/agent/agentHost.test.ts \
  electron/agent/goalHost.test.ts \
  electron/agent/workspaceHandle.test.ts \
  electron/agent/sessionUiAdapter.test.ts \
  electron/agent/copyPiAdjacentAssets.test.ts
cd ../cli && node --import tsx --test src/json-event.test.ts src/pi-worker.test.ts
cd ../extensions && npx vitest run multi-agent/ _shared/workspace-context.test.ts
```

对照规格「验证」节：宿主骨架 / SessionUiAdapter / Goal / workspace 上下文 / 短调用 / Fork / 打包。缺哪条补哪条，不要只改文档。

- [ ] **步骤 6：渲染层与 tauri 零改动**

```bash
git diff --stat main -- electron-agent/src/ tauri-agent/
```

预期：`tauri-agent/` 零行。`electron-agent/src/` 若有 diff，逐行确认是否必要（规格：渲染层控件、IPC 不重命名；线协议字段不得改）。

- [ ] **步骤 7：合并条件清单**

- [ ] 无双栈：sidecar 全删；交互 / Goal / 短调用 / 子代理都走新路径
- [ ] 产物无 `resources/pi`；`asarUnpack` 仍含 `@colbymchenry/**`；`pi-worker.js` 可 spawn
- [ ] `code-exec` runner 与 `fable-behavior/prompts` 在 `out/main` 可达
- [ ] `@earendil-works/pi-ai` 单实例
- [ ] 打包冒烟（任务 5）全部通过
- [ ] 未通过恢复 sidecar 绕过任何失败

- [ ] **步骤 8：Commit**

```bash
git add -A
git commit -m "chore: finish in-process Pi SDK host cleanup and typecheck baseline"
```

---

## 交付标准

本份完成时：

- `PiClient`、`jsonl.ts`、sidecar `manager.ts`、`runtimePaths.ts` 已删除；`eventAdapter.ts` 与改写后的 `systemWorkerManager.ts` 保留。
- `scripts/build-sidecar.mjs`、`build:sidecar`、`extraResources: resources/pi`、`resources/pi` 已删除。
- 无 `GREN_PI_COMMAND` / `pi.exe` 解析；无 `mcpPolicyService.piCommand`；无「临时 `PiRuntimeService` 只为 refresh」。
- `cli/src/runtime.ts` 的 rpc / oneshot / probe **子命令入口**已删，模块保留。
- 三包 SDK 是 `electron-agent` 依赖，vite `dedupe` 生效，**未**被 external。
- `@ast-grep/napi` 是依赖，external + asarUnpack；`@colbymchenry/**` 与 `afterPack` 仍在。
- `out/main/` 含 `runner.py`、`runner.mjs`、`prompts/`、`pi-worker.js`。
- 打包产物在 `release/`（不是 `dist/`），冒烟 8 项通过。
- `tsc -p tsconfig.node.json --noEmit` 达到任务 7 的约定。
- 升级检查清单已建立。

**本份完成后主线可合并。**

---

## 回滚预案

若任务 5 冒烟反复失败：

1. **不要**恢复 sidecar 或 `extraResources: resources/pi`。
2. 分支不合并，继续修路径 / external / 复制清单。
3. **不要**改走「复制 `../extensions` + 其 `node_modules`」。那是审查否决的方案 B。
4. 原生模块失败先查 asarUnpack 是否覆盖掉了 `@colbymchenry`，再查 `@ast-grep` 是否进了 `dependencies`。
5. `import.meta.url` ENOENT 先确认 `copyPiAdjacentAssets` 是否在 vite `closeBundle` 跑过，再确认 asarUnpack 是否包含 `runner.py`。
