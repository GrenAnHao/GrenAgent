# GrenAgent 产品图标 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用现有 π 做成系统级产品图标，接到 Windows / macOS / Linux 打包、运行时窗口和页面 favicon。

**架构：** `build/icon.svg` 是 1024 主图（π + `#0b0d12` 圆角底）。`scripts/generate-icons.mjs` 栅格化后提交 `icon.ico` / `icon.icns` / `icon.png` / `public/favicon.*`。`resolveAppIcon(packaged, appPath, mainDir)` 给 `BrowserWindow`；builder 按平台指向上面三个文件。不改标题栏、空会话 π、启动页动画。

**技术栈：** SVG、sharp、png-to-ico、png2icons、electron-builder、Vitest、Electron `BrowserWindow.icon`。

**上游规格：** `docs/superpowers/specs/2026-09-16-product-icon-design.md`。按该规格实现，不要另画图形。

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。**
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。
- **用户未明确要求提交时，跳过每个任务的 Commit 步骤**，把变更留在工作区。
- **不要改** `PiBrandLogo.tsx`、`GrenAgentBrand.tsx`、`Titlebar.tsx`、`EmptyChatPrompt.tsx`、`FullscreenLoading.tsx`。
- **不要** 把图标放进标题栏，不要设 `nsis.installerIcon`，不要在 `pnpm package` / `electron-vite build` 里自动跑生成脚本。
- Vitest `main` project 只包含 `electron/**/*.test.ts`。图标测试放 `electron/app/productIcon.test.ts`，**不要**放 `scripts/*.test.ts`（不会被跑到）。
- 生成脚本本身不进 `pnpm test`。测试只读已提交产物和配置。
- `ico` 必须用各尺寸 PNG 组装（16 / 24 用 12% 内边距），**禁止** `png2icons.createICO(单张 1024 PNG)`，否则小尺寸补偿会丢。`png2icons` 只用于 `createICNS`。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

**提交（仅当用户要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(图标): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/build/icon.svg` | 1024 主图：π path、底 `#0b0d12`、`rx=320` |
| `electron-agent/build/icon.png` | 1024 PNG（脚本生成，入仓） |
| `electron-agent/build/icon.ico` | 16–256 多层（脚本生成，入仓） |
| `electron-agent/build/icon.icns` | macOS（脚本生成，入仓） |
| `electron-agent/public/favicon.ico` | 16 + 32 |
| `electron-agent/public/favicon.png` | 32×32 |
| `electron-agent/scripts/generate-icons.mjs` | 读 SVG，原子写出上述栅格产物 |
| `electron-agent/electron/app/productIcon.test.ts` | SVG / 产物存在 / builder / favicon / ICO 尺寸 |

修改：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/mainConfig.ts` | 新增 `resolveAppIcon`；`browserWindowOptions` 不设 `icon` |
| `electron-agent/electron/main.config.test.ts` | `resolveAppIcon` 两条路径；常量上无 `icon` |
| `electron-agent/electron/main.ts` | `createWindow` 传入 `icon: resolveAppIcon(...)` |
| `electron-agent/electron-builder.yml` | `buildResources`、`files` 加 ico、win/mac/linux `icon` |
| `electron-agent/index.html` | `<link rel="icon" href="./favicon.ico" />` |
| `electron-agent/package.json` | `icons` script；devDependencies：`sharp`、`png-to-ico`、`png2icons` |

π path 字符串（两处必须相同，不要改）：

```
M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z
```

---

### 任务 1：主 SVG 与 path 同步测试

**文件：**
- 创建：`electron-agent/electron/app/productIcon.test.ts`
- 创建：`electron-agent/build/icon.svg`

- [ ] **步骤 1：编写失败的测试**

`electron-agent/electron/app/productIcon.test.ts`：

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const PI_PATH = 'M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z';

describe('product icon source', () => {
  it('keeps the 1024 SVG mark, colors and squircle radius', () => {
    const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('rx="320"');
    expect(svg).toContain('#0b0d12');
    expect(svg).toContain('#e6e8ec');
    expect(svg).toContain(PI_PATH);
  });

  it('uses the same pi path as PiBrandLogo', () => {
    const logo = readFileSync(join(root, 'src', 'components', 'PiBrandLogo.tsx'), 'utf8');
    expect(logo).toContain(PI_PATH);
  });
});
```

先不要写产物存在性、builder、favicon 那些用例（后面任务再加）。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts
```

预期：FAIL，`build/icon.svg` ENOENT。

- [ ] **步骤 3：写入主 SVG**

创建 `electron-agent/build/icon.svg`（几何：内容区 60% 边长、π `contain` 居中；`scale = 614.4/160 = 3.84`）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="320" ry="320" fill="#0b0d12"/>
  <g fill="#e6e8ec" fill-rule="evenodd" transform="translate(204.8 254.72) scale(3.84) translate(-40 -56)">
    <path d="M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z"/>
  </g>
</svg>
```

不要加不透明方底。四角保持透明。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/productIcon.test.ts electron-agent/build/icon.svg
git commit -m @"
feat(图标): 提交 1024 π 主 SVG 与 path 同步测试

"@
```

---

### 任务 2：`resolveAppIcon` 与窗口图标

**文件：**
- 修改：`electron-agent/electron/mainConfig.ts`
- 修改：`electron-agent/electron/main.config.test.ts`
- 修改：`electron-agent/electron/main.ts`

- [ ] **步骤 1：编写失败的测试**

在 `electron-agent/electron/main.config.test.ts` 的 import 中把 `resolveAppIcon` 加进现有 import。追加：

```ts
describe('resolveAppIcon', () => {
  it('resolves the repo build ico while unpackaged', () => {
    const mainDir = join('C:', 'proj', 'out', 'main');
    expect(resolveAppIcon(false, join('C:', 'app.asar'), mainDir)).toBe(
      join('C:', 'proj', 'build', 'icon.ico'),
    );
  });

  it('resolves the asar build ico when packaged and ignores mainDir', () => {
    const appPath = join('C:', 'app.asar');
    expect(resolveAppIcon(true, appPath, join('C:', 'proj', 'out', 'main'))).toBe(
      join(appPath, 'build', 'icon.ico'),
    );
  });
});
```

在现有 `enables required BrowserWindow security settings` 用例末尾追加：

```ts
expect(browserWindowOptions.icon).toBeUndefined();
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/main.config.test.ts
```

预期：FAIL，`resolveAppIcon` is not exported。

- [ ] **步骤 3：实现 `resolveAppIcon` 并接到 `createWindow`**

`electron-agent/electron/mainConfig.ts` 在 `resolveRendererHtml` 之后追加：

```ts
/** unpackaged：相对 main 编译目录；packaged：asar 根下的 build/icon.ico。 */
export function resolveAppIcon(packaged: boolean, appPath: string, mainDir: string): string {
  if (packaged) return join(appPath, 'build', 'icon.ico');
  return join(mainDir, '../../build/icon.ico');
}
```

`browserWindowOptions` 不要加 `icon` 字段。

`electron-agent/electron/main.ts`：现有 import

```ts
import { browserWindowOptions, resolveRendererHtml } from "./mainConfig";
```

改为：

```ts
import { browserWindowOptions, resolveAppIcon, resolveRendererHtml } from "./mainConfig";
```

`createWindow` 里：

```ts
export function createWindow() {
  const window = new BrowserWindow({
    ...browserWindowOptions,
    icon: resolveAppIcon(app.isPackaged, app.getAppPath(), __dirname),
  });
```

其余 `attachWebviewSecurity` / `loadURL` / `loadFile` 不动。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/main.config.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/mainConfig.ts electron-agent/electron/main.config.test.ts electron-agent/electron/main.ts
git commit -m @"
feat(图标): 按打包状态解析窗口 ico

"@
```

---

### 任务 3：electron-builder 图标路径

**文件：**
- 修改：`electron-agent/electron/app/productIcon.test.ts`
- 修改：`electron-agent/electron-builder.yml`

- [ ] **步骤 1：编写失败的测试**

在 `productIcon.test.ts` 追加：

```ts
describe('product icon packaging', () => {
  it('points electron-builder at the committed icon files', () => {
    const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
      directories?: { buildResources?: string };
      files?: string[];
      win?: { icon?: string };
      mac?: { icon?: string };
      linux?: { icon?: string };
      nsis?: { installerIcon?: string };
    };
    expect(config.directories?.buildResources).toBe('build');
    expect(config.files).toContain('build/icon.ico');
    expect(config.win?.icon).toBe('build/icon.ico');
    expect(config.mac?.icon).toBe('build/icon.icns');
    expect(config.linux?.icon).toBe('build/icon.png');
    expect(config.nsis?.installerIcon).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts
```

预期：FAIL，`buildResources` 为 `undefined`。

- [ ] **步骤 3：改 `electron-builder.yml`**

`directories` 改为：

```yml
directories:
  output: release
  buildResources: build
```

`files` 在 `package.json` 那一行后面加一行（其余 `asarUnpack` / `afterPack` 一行都不要动）：

```yml
files:
  - dist/**
  - out/**
  - package.json
  - build/icon.ico
```

`win` / `mac` / `linux` 改为：

```yml
win:
  icon: build/icon.ico
  target:
    - nsis
mac:
  icon: build/icon.icns
  target:
    - dmg
linux:
  icon: build/icon.png
  target:
    - AppImage
```

不要加 `nsis.installerIcon`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts electron/app/codeGraph/sdkPackaging.test.ts
```

预期：PASS。`sdkPackaging.test.ts` 仍读同一份 yml，确认 `asarUnpack` / `afterPack` 没被改坏。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/productIcon.test.ts electron-agent/electron-builder.yml
git commit -m @"
feat(图标): 把 builder 指向已提交的平台图标

"@
```

---

### 任务 4：生成脚本与入仓产物

**文件：**
- 创建：`electron-agent/scripts/generate-icons.mjs`
- 修改：`electron-agent/package.json`
- 修改：`electron-agent/pnpm-lock.yaml`（`pnpm add` 自动改）
- 创建：`electron-agent/build/icon.png`、`electron-agent/build/icon.ico`、`electron-agent/build/icon.icns`
- 创建：`electron-agent/public/favicon.ico`、`electron-agent/public/favicon.png`
- 修改：`electron-agent/electron/app/productIcon.test.ts`

- [ ] **步骤 1：编写失败的产物测试**

在 `productIcon.test.ts` 追加：

```ts
const ARTIFACTS = [
  'build/icon.ico',
  'build/icon.png',
  'build/icon.icns',
  'public/favicon.ico',
  'public/favicon.png',
] as const;

function icoSizes(buf: Buffer): number[] {
  const count = buf.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const width = buf[6 + i * 16];
    sizes.push(width === 0 ? 256 : width);
  }
  return sizes;
}

describe('product icon artifacts', () => {
  it('commits raster files with non-empty bytes', () => {
    for (const relative of ARTIFACTS) {
      const path = join(root, relative);
      expect(existsSync(path), relative).toBe(true);
      expect(statSync(path).size, relative).toBeGreaterThan(0);
    }
  });

  it('embeds 16-256 layers in icon.ico', () => {
    const sizes = icoSizes(readFileSync(join(root, 'build', 'icon.ico')));
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes, `missing ${size}`).toContain(size);
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts
```

预期：FAIL，`build/icon.ico` 不存在。

- [ ] **步骤 3：安装依赖并加 npm script**

在 `electron-agent/`：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; pnpm add -D sharp png-to-ico png2icons
```

`package.json` 的 `scripts` 增加（不要改 `package` 脚本）：

```json
"icons": "node scripts/generate-icons.mjs"
```

确认 `scripts.package` 仍是 `electron-builder --config electron-builder.yml`，里面没有 `icons`。

- [ ] **步骤 4：写生成脚本**

创建 `electron-agent/scripts/generate-icons.mjs`：

```js
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const pngToIco = require('png-to-ico');
const png2icons = require('png2icons');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'build', 'icon.svg');
const PI_BOX = { x: 40, y: 56, w: 160, h: 134 };
const RX_RATIO = 0.3125;
const PAD_SMALL = 0.12;
const PAD_NORMAL = 0.2;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function padFor(size) {
  return size === 16 || size === 24 ? PAD_SMALL : PAD_NORMAL;
}

function buildSvg(size, padRatio, pathD, bg, fg) {
  const inner = size * (1 - 2 * padRatio);
  const scale = Math.min(inner / PI_BOX.w, inner / PI_BOX.h);
  const dx = (size - PI_BOX.w * scale) / 2;
  const dy = (size - PI_BOX.h * scale) / 2;
  const rx = size * RX_RATIO;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${bg}"/>
  <g fill="${fg}" fill-rule="evenodd" transform="translate(${dx} ${dy}) scale(${scale}) translate(${-PI_BOX.x} ${-PI_BOX.y})">
    <path d="${pathD}"/>
  </g>
</svg>`;
}

async function raster(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function mustExist(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`empty icon artifact: ${path}`);
}

async function main() {
  let svg;
  try {
    svg = await readFile(SRC, 'utf8');
  } catch (error) {
    console.error(`missing source SVG: ${SRC}`);
    process.exitCode = 1;
    return;
  }

  const pathD = /<path d="([^"]+)"/.exec(svg)?.[1];
  if (!pathD) {
    console.error(`SVG missing pi path: ${SRC}`);
    process.exitCode = 1;
    return;
  }
  if (!svg.includes('#0b0d12') || !svg.includes('#e6e8ec')) {
    console.error(`SVG missing brand colors: ${SRC}`);
    process.exitCode = 1;
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'gren-icons-'));
  try {
    const pngBySize = new Map();
    pngBySize.set(1024, await raster(svg));
    for (const size of ICO_SIZES) {
      const layerSvg = size <= 24 ? buildSvg(size, padFor(size), pathD, '#0b0d12', '#e6e8ec') : svg;
      pngBySize.set(size, size <= 24 ? await raster(layerSvg) : await sharp(pngBySize.get(1024)).resize(size, size).png().toBuffer());
    }

    const pngDir = join(tmp, 'png');
    await mkdir(pngDir, { recursive: true });
    const icoInputs = [];
    for (const size of ICO_SIZES) {
      const file = join(pngDir, `${size}.png`);
      await writeFile(file, pngBySize.get(size));
      icoInputs.push(file);
    }

    const ico = await pngToIco(icoInputs);
    const favicon = await pngToIco([join(pngDir, '16.png'), join(pngDir, '32.png')]);
    const icns = png2icons.createICNS(pngBySize.get(1024), png2icons.BICUBIC2, 0);
    if (!icns) throw new Error('png2icons.createICNS returned null');

    await writeFile(join(tmp, 'icon.png'), pngBySize.get(1024));
    await writeFile(join(tmp, 'icon.ico'), ico);
    await writeFile(join(tmp, 'icon.icns'), icns);
    await writeFile(join(tmp, 'favicon.ico'), favicon);
    await writeFile(join(tmp, 'favicon.png'), pngBySize.get(32));

    for (const name of ['icon.png', 'icon.ico', 'icon.icns', 'favicon.ico', 'favicon.png']) {
      await mustExist(join(tmp, name));
    }

    await mkdir(join(ROOT, 'build'), { recursive: true });
    await mkdir(join(ROOT, 'public'), { recursive: true });
    await copyFile(join(tmp, 'icon.png'), join(ROOT, 'build', 'icon.png'));
    await copyFile(join(tmp, 'icon.ico'), join(ROOT, 'build', 'icon.ico'));
    await copyFile(join(tmp, 'icon.icns'), join(ROOT, 'build', 'icon.icns'));
    await copyFile(join(tmp, 'favicon.ico'), join(ROOT, 'public', 'favicon.ico'));
    await copyFile(join(tmp, 'favicon.png'), join(ROOT, 'public', 'favicon.png'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
```

失败时只 `exitCode = 1`，不要 `copyFile` 到 `build/` / `public/`（临时目录在 `finally` 删掉，旧产物保留）。

- [ ] **步骤 5：跑脚本生成产物**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; pnpm icons
```

预期：exit 0，上述五个栅格文件出现。若 sharp 报 SVG 无法解码，先确认 `icon.svg` 有 `xmlns="http://www.w3.org/2000/svg"`，再重跑。不要改用单张 PNG 生成 ico。

- [ ] **步骤 6：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts
```

预期：PASS。

在 `productIcon.test.ts` 再加一条（现在就能过）：

```ts
describe('product icon scripts', () => {
  it('exposes a manual icons script and does not hook package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.icons).toBe('node scripts/generate-icons.mjs');
    expect(pkg.scripts.package).toBe('electron-builder --config electron-builder.yml');
    expect(pkg.scripts.package).not.toContain('icons');
  });
});
```

再跑同一条 vitest，预期仍 PASS。

- [ ] **步骤 7：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/scripts/generate-icons.mjs electron-agent/package.json electron-agent/pnpm-lock.yaml electron-agent/build/icon.png electron-agent/build/icon.ico electron-agent/build/icon.icns electron-agent/public/favicon.ico electron-agent/public/favicon.png electron-agent/electron/app/productIcon.test.ts
git commit -m @"
feat(图标): 用脚本生成并提交多层 ico 与 icns

"@
```

---

### 任务 5：页面 favicon

**文件：**
- 修改：`electron-agent/index.html`
- 修改：`electron-agent/electron/app/productIcon.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `productIcon.test.ts` 追加：

```ts
describe('product icon favicon', () => {
  it('links index.html at /favicon.ico', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toMatch(/rel=["']icon["']/);
    expect(html).toContain('href="./favicon.ico"');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts
```

预期：FAIL，`index.html` 不含 `rel="icon"`。

- [ ] **步骤 3：加 link**

`electron-agent/index.html` 的 `<title>GrenAgent</title>` 后面插入：

```html
    <link rel="icon" href="./favicon.ico" />
```

不要改 boot-splash 样式。Vite renderer `root` 已是 `electron-agent/`，`public/` 会映射到 `/`，不必改 `electron.vite.config.ts`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/productIcon.test.ts electron/main.config.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/index.html electron-agent/electron/app/productIcon.test.ts
git commit -m @"
feat(图标): 给页面加上 favicon

"@
```

---

## 自检

| 规格 | 任务 |
| --- | --- |
| §2 主 SVG、色、rx、π path | 任务 1 |
| §7.1 / §7.2 path 同步 | 任务 1 |
| §4.2 / §7.5 / §7.7 `resolveAppIcon`、常量无 icon | 任务 2 |
| §4.1 / §7.4 builder 路径、files、无 installerIcon | 任务 3 |
| §2.2 小尺寸 12% 内边距、§3 脚本与原子写、§5 失败不覆盖 | 任务 4 |
| §7.3 产物存在、§7 成功标准 4 的 ICO 层 | 任务 4 |
| §3.1 `icons` script、package 不挂钩 | 任务 4 |
| §4.3 / §7.6 favicon link | 任务 5 |
| 非目标：不改 PiBrandLogo / Titlebar / 启动页 | 各任务均未列出这些文件 |

无「待定」步骤。`resolveAppIcon` 签名三处一致：`(packaged, appPath, mainDir)`。
