# GrenAgent 源码保护 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 生产构建把主进程 `main` / `pi-worker` 编成 V8 字节码，打包时打开 ASAR 完整性 fuse；预加载不编，窗口沙箱保持开启。

**架构：** electron-vite 6 的 `main.build.bytecode` 只对 CJS 产物生效。先去掉 `package.json` 的 `"type": "module"` 并显式 `output.format: "cjs"`，再开字节码。入口变成两行 `require` 存根 + `.jsc`；worker 侧把存根、`pi-worker.jsc`、`bytecode-loader.cjs` 解包。`electronFuses` 开完整性校验和 `onlyLoadAppFromAsar`，不关 `runAsNode`。

**技术栈：** electron-vite 6 `build.bytecode`、electron-builder `electronFuses`、Electron 38、Vitest、yaml。

**上游规格：** `docs/superpowers/specs/2026-09-17-source-code-protection-design.md`。按该规格实现，不要改 spawn、不要编预加载。

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。**
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。
- **用户未明确要求提交时，跳过每个任务的 Commit 步骤**，把变更留在工作区。
- **字节码在非 CJS 上是静默失效**（插件 warning 后跳过，构建仍成功）。必须同时：删 `"type": "module"`、设 `output.format: "cjs"`。只加 bytecode 而不改格式等于没做。
- **实现期裁决 A：** `bytecode` 必须是 `{ transformArrowFunctions: false }`，不能是布尔 `true`。undici class 字段箭头会让 Babel 转箭头在构建期崩。
- **fuse 键名是 camelCase**（`enableEmbeddedAsarIntegrityValidation`）。不要抄 electron-vite 文档里的 PascalCase。
- **禁止** `runAsNode: false`。子代理靠 `ELECTRON_RUN_AS_NODE=1`。
- **禁止** `asar.disableIntegrity`。
- **不要** 给 preload / renderer 加 `bytecode`，不要把 `sandbox` 改成 `false`。
- **不要** 解包 `out/main/main.jsc`。**必须** 解包 `pi-worker.jsc` 和 `bytecode-loader.cjs`。
- **不要改** `mainConfig.ts`、`workerEntry.ts`、`preload.ts`、`webviewPreload.ts`、`extensions/multi-agent/runner.ts`。
- Vitest `main` project 只包含 `electron/**/*.test.ts`。测试放 `electron/app/sourceCodeProtection.test.ts`。
- 配置测试不调用 `electron-vite build`。`.jsc` 是否真正产出放任务 4 手动验证。
- **已知缺口（不要写成已防护）：** `out/main/chunks/**` 已整目录解包，主进程 chunk 的 `.jsc` 和 worker 侧文件都不在 ASAR 哈希里，只到字节码混淆。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/sourceCodeProtection.test.ts
```

**提交（仅当用户要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(保护): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/app/sourceCodeProtection.test.ts` | 断言 vite 字节码 + CJS、无 `type: module`、fuse、asarUnpack 三件套 |

修改：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron.vite.config.ts` | `main.build.bytecode: { transformArrowFunctions: false }`；`rollupOptions.output.format: "cjs"` |
| `electron-agent/package.json` | 删除 `"type": "module"`；`main` / `scripts` 不动 |
| `electron-agent/electron-builder.yml` | `electronFuses` 两键；`asarUnpack` 追加 `pi-worker.jsc` 与 `bytecode-loader.cjs` |

不改：`mainConfig.ts`、`workerEntry.ts`、preload、runner、`package.json` 的 `main` / `scripts`。

---

### 任务 1：主进程 CJS + 字节码配置

**文件：**
- 创建：`electron-agent/electron/app/sourceCodeProtection.test.ts`
- 修改：`electron-agent/electron.vite.config.ts`
- 修改：`electron-agent/package.json`

- [ ] **步骤 1：编写失败的测试**

`electron-agent/electron/app/sourceCodeProtection.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import viteConfig from '../../electron.vite.config';

const root = resolve(__dirname, '../..');

function outputFormat(output: unknown): string | undefined {
  if (!output) return undefined;
  if (Array.isArray(output)) return output[0]?.format;
  return (output as { format?: string }).format;
}

describe('source code protection: electron-vite main', () => {
  it('compiles main to CJS bytecode and leaves preload/renderer as JS', () => {
    expect(viteConfig.main.build.bytecode).toBe(true);
    expect(outputFormat(viteConfig.main.build.rollupOptions?.output)).toBe('cjs');
    expect(viteConfig.preload.build.bytecode).toBeUndefined();
    expect(viteConfig.renderer.build?.bytecode).toBeUndefined();
  });

  it('drops package type module so Electron treats out/main JS as CJS', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      type?: string;
      main?: string;
    };
    expect(pkg).not.toHaveProperty('type');
    expect(pkg.main).toBe('out/main/main.js');
  });
});
```

若 vitest 加载 `electron.vite.config.ts` 因 `__dirname` 失败：删掉该 import，改读 `join(root, 'electron.vite.config.ts')` 源文本，断言含 `bytecode: true`、`format: "cjs"`，且 `preload:` 到 `renderer:` 之间、以及 `renderer:` 块内都不含 `bytecode`。不要两种断言并存。

本任务先不要写 fuse / asarUnpack 用例。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/sourceCodeProtection.test.ts
```

预期：FAIL。`bytecode` 为 `undefined`，`output.format` 为 `undefined`，`package.json` 仍有 `"type": "module"`。

- [ ] **步骤 3：写最少实现**

`electron-agent/electron.vite.config.ts` 的 `main.build` 改成（`resolve` / `plugins` / `external` 原样保留）：

```ts
    build: {
      bytecode: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, "electron/main.ts"),
          "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
        },
        output: { format: "cjs" },
        external: [
          "@homebridge/node-pty-prebuilt-multiarch",
          "@colbymchenry/codegraph",
          "@ast-grep/napi",
          "@vscode/ripgrep",
          /^node:/,
        ],
      },
    },
```

`preload` / `renderer` 一块都不要动。不要写 `bytecode: { ... }` 对象。

`electron-agent/package.json` **删除** 这一行，其它字段不动：

```json
  "type": "module",
```

删除后文件开头是：

```json
{
  "name": "electron-agent",
  "version": "0.1.0",
  "private": true,
  "main": "out/main/main.js",
```

不要改成 `"type": "commonjs"`。不要改 `main` 或 `scripts`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/sourceCodeProtection.test.ts
```

预期：PASS。

立刻再跑一次，确认去掉 `type: module` 没有弄坏现有测试：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts electron/app/codeGraph/sdkPackaging.test.ts electron/main.config.test.ts
```

预期：PASS。`sdkPackaging.test.ts` 仍用源文本检查 `@colbymchenry/codegraph` external，不受 `bytecode` 影响。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/sourceCodeProtection.test.ts electron-agent/electron.vite.config.ts electron-agent/package.json
git commit -m @"
feat(保护): 主进程改为 CJS 并开启字节码

"@
```

---

### 任务 2：ASAR fuse 与 worker 解包

**文件：**
- 修改：`electron-agent/electron/app/sourceCodeProtection.test.ts`
- 修改：`electron-agent/electron-builder.yml`

- [ ] **步骤 1：把失败的打包断言追加进同一测试文件**

在任务 1 的 `describe` 后面追加（保留已有 import：`readFileSync`、`join`、`parse`）：

```ts
describe('source code protection: electron-builder', () => {
  const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
    asar?: boolean | { disableIntegrity?: boolean };
    asarUnpack?: string[];
    electronFuses?: {
      enableEmbeddedAsarIntegrityValidation?: boolean;
      onlyLoadAppFromAsar?: boolean;
      runAsNode?: boolean;
    };
  };

  it('enables asar integrity fuses without disabling runAsNode', () => {
    expect(config.electronFuses?.enableEmbeddedAsarIntegrityValidation).toBe(true);
    expect(config.electronFuses?.onlyLoadAppFromAsar).toBe(true);
    expect(config.electronFuses?.runAsNode).not.toBe(false);
    if (config.asar && typeof config.asar === 'object') {
      expect(config.asar.disableIntegrity).not.toBe(true);
    } else {
      expect(config.asar).toBe(true);
    }
  });

  it('unpacks the worker stub, bytecode and loader, not main.jsc', () => {
    expect(config.asarUnpack).toContain('out/main/pi-worker.js');
    expect(config.asarUnpack).toContain('out/main/pi-worker.jsc');
    expect(config.asarUnpack).toContain('out/main/bytecode-loader.cjs');
    expect(config.asarUnpack).not.toContain('out/main/main.jsc');
  });
});
```

键名必须是 camelCase，不要断言 PascalCase。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/sourceCodeProtection.test.ts
```

预期：任务 1 的两例仍 PASS；新建两例 FAIL（没有 `electronFuses`，`asarUnpack` 没有 `.jsc` / `bytecode-loader.cjs`）。

- [ ] **步骤 3：改 `electron-builder.yml`**

在现有 `asar: true` **下面**插入（与 `asar` 同级，不要包进 `build:`）：

```yml
asar: true
electronFuses:
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
asarUnpack:
```

在 `asarUnpack` 的 `out/main/pi-worker.js` **下面**追加两行，其余条目原样保留：

```yml
  - out/main/pi-worker.js
  - out/main/pi-worker.jsc
  - out/main/bytecode-loader.cjs
  - out/main/chunks/**
```

完整相关片段完成后应是：

```yml
asar: true
electronFuses:
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
asarUnpack:
  - node_modules/@colbymchenry/**
  - node_modules/@ast-grep/**
  - node_modules/@vscode/ripgrep/**
  - node_modules/@vscode/ripgrep-*/**
  - node_modules/.pnpm/@vscode+ripgrep*/**
  - out/main/pi-worker.js
  - out/main/pi-worker.jsc
  - out/main/bytecode-loader.cjs
  - out/main/chunks/**
  - out/main/runner.py
  - out/main/runner.mjs
  - out/main/prompts/**
  # 选 A：预编译 helper 入仓后由 copyPiAdjacentAssets 拷到 out/main。
  # asar:true 下 exe 必须 unpack，否则无法 spawn。
  - out/main/pi-sandbox-win.exe
  - out/main/chunks/pi-sandbox-win.exe
```

不要写 `runAsNode: false`。不要写 `asar.disableIntegrity`。不要解包 `out/main/main.jsc`。不要改 `afterPack`、`files`、各平台 `target`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/sourceCodeProtection.test.ts
```

预期：四个用例全部 PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/sourceCodeProtection.test.ts electron-agent/electron-builder.yml
git commit -m @"
feat(保护): 打开 ASAR 完整性并解包 worker 字节码

"@
```

---

### 任务 3：回归既有打包与沙箱断言

**文件：** 不改业务代码。只跑测试。

- [ ] **步骤 1：跑会读同一份 yml / 窗口选项 / worker 路径的测试**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/sourceCodeProtection.test.ts electron/app/productIcon.test.ts electron/app/codeGraph/sdkPackaging.test.ts electron/agent/copyPiAdjacentAssets.test.ts electron/agent/workerEntry.test.ts electron/main.config.test.ts
```

预期：全部 PASS。

核对这些既有断言仍成立（测试会替你核对，实现者不要改它们来迁就）：

- `sdkPackaging.test.ts`：`asarUnpack` 仍含 `@colbymchenry/**` 与 ripgrep 三条；`afterPack` 仍是 `./scripts/package-codegraph.cjs`。
- `copyPiAdjacentAssets.test.ts`：仍含 `out/main/pi-sandbox-win.exe` 与 chunks 下同名 exe。
- `workerEntry.test.ts`：打包态仍是 `app.asar.unpacked/out/main/pi-worker.js`。
- `main.config.test.ts`：`sandbox: true`；`icon` 仍不在 `browserWindowOptions` 常量上。

若有失败：修任务 1 / 2 的配置，**不要**放宽这些旧测试。

- [ ] **步骤 2：Commit**（本任务无文件变更则跳过）

---

### 任务 4：生产构建冒烟（抓静默失效）

**文件：** 不改源码。本任务不进 `pnpm test`。

- [ ] **步骤 1：生产构建**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; pnpm build
```

预期：`tsc` 与 `electron-vite build` 成功。构建日志里不应只有 “bytecode is ignored because output format is not cjs” 然后继续成功——若出现这条 warning，任务 1 的 CJS 前提没落地，停下来修，不要打包。

- [ ] **步骤 2：确认字节码产物**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"
Get-Item out/main/main.jsc, out/main/pi-worker.jsc, out/main/bytecode-loader.cjs | Select-Object Name, Length
Get-Content out/main/main.js
Write-Host "-----"
Get-Content out/main/pi-worker.js
```

预期：

- 三个文件存在且 `Length` 大于 0。
- `main.js` 与 `pi-worker.js` 是存根：含 `require("./bytecode-loader.cjs")`，以及 `require("./main.jsc")` / `require("./pi-worker.jsc")`。
- 这两个 `.js` **不以** `import ` 开头（那是 ESM，说明字节码被跳过）。
- 不要解包 `main.jsc`；它只要出现在 `out/main/` 即可，打进 asar 是 builder 的事。

任一缺失或仍是大份 ESM bundle：失败。回到任务 1，检查 `bytecode: true`、`format: "cjs"`、`package.json` 没有 `type: module`。

- [ ] **步骤 3（可选，有安装包时）：打包启动**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; pnpm package
```

启动安装后的 GrenAgent：主窗口能开。再触发一次子代理（`spawn_agent`）：应能起来。若子代理立刻退出，先查 `app.asar.unpacked/out/main/` 是否同时有 `pi-worker.js`、`pi-worker.jsc`、`bytecode-loader.cjs`。

手动把 `app.asar.unpacked/out/main/pi-worker.jsc` 改坏：子代理失败，主窗口仍可用。这是规格 §4 的残留风险边界，不是回归失败。

不要在本任务改代码去「修复」解包目录可被替换——那是已知缺口。

- [ ] **步骤 4：Commit**（本任务无文件变更则跳过）

---

## 自检

| 规格 | 任务 |
| --- | --- |
| §2 `bytecode: true` + `output.format: "cjs"`；preload / renderer 不编 | 任务 1 |
| §2 / §7.3 删除 `"type": "module"` | 任务 1 |
| §7.1 / §7.2 优先 import 配置对象 | 任务 1 |
| §3 / §7.5 camelCase fuse；不开 `runAsNode: false`；无 `disableIntegrity` | 任务 2 |
| §4 / §7.6 解包 `pi-worker.js` + `.jsc` + `bytecode-loader.cjs`；不解包 `main.jsc` | 任务 2 |
| §7.4 `sandbox: true`、§7.7 `resolveWorkerEntry` | 任务 3（既有测试，不改代码） |
| §5 静默失效：`pnpm build` 后必须有 `.jsc` 且入口是 `require` 存根 | 任务 4 |
| §4 残留风险：解包 `.jsc` 可被替换；主进程 chunk 在 `chunks/**` | 任务 4 步骤 3；动工前必读已写明 |
| 非目标：不改 sandbox / spawn / preload / protectedStrings / 多架构 | 各任务均未列出这些文件 |

无「待定」步骤。fuse 键名与规格一致（camelCase）。worker 入口文件名始终是 `pi-worker.js`。
