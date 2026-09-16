# GrenAgent 产品图标

- 日期：2026-09-16
- 状态：规格已按头脑风暴裁决写完，可进 writing-plans
- 主题：用现有 π 做成系统级产品图标，覆盖 Windows / macOS / Linux 打包、运行时窗口和页面 favicon。

> **裁决记录（2026-09-16）**
>
> - **覆盖：** 完整系统图标。Win `.ico` + macOS `.icns` + Linux `.png` + `BrowserWindow.icon` + `index.html` favicon。
> - **图形：** 现有 `PiBrandLogo` π 路径，底 `#0b0d12`，笔画 `#e6e8ec`。不另画新标。
> - **外轮廓：** squircle 取向，实现为圆角矩形，圆角半径为边长的 31.25%（选型 B 的 20 / 64）。
> - **做法：** 主 SVG + `generate-icons.mjs` 生成多层 ico / icns / png / favicon；生成物入仓。`pnpm package` 不自动跑脚本。
> - **不动：** 标题栏字样、空会话 π、启动页 `BrandLoading` 动画。

## 1. 目标

GrenAgent 打包后的 exe、安装包、任务栏、开发时窗口和页面 tab 都还是 Electron 默认图标。应用内已经有 π，系统和页面没有同一套标。

改完之后：

1. Windows 安装包、桌面快捷方式、任务栏、运行中窗口使用同一套多层 `.ico`。
2. macOS 使用 `.icns`，Linux 使用 1024 PNG。
3. `electron-vite dev` 的窗口不是默认 Electron 图标。
4. `index.html` 有 favicon，开发服务器和打包后的页面 tab 都显示 π。
5. 标题栏、空会话标题、启动页动画视觉不变。

### 成功标准

1. `electron-builder.yml` 的 `win.icon` / `mac.icon` / `linux.icon` 分别指向 `build/icon.ico`、`build/icon.icns`、`build/icon.png`。
2. `createWindow()` 创建的 `BrowserWindow` 带 `icon`，路径由 `resolveAppIcon()` 给出。
3. `index.html` 含 `<link rel="icon" href="./favicon.ico" />`，`public/favicon.ico` 存在。
4. `build/icon.ico` 至少包含 16、24、32、48、64、128、256 各一层。
5. 16 / 24 两档的 π 内边距为 12%；64 及以上为 20%。
6. `pnpm test` 覆盖 §7 的断言，不引入像素对比。

### 非目标

- 不改 `PiBrandLogo`、`GrenAgentBrand`、`Titlebar`、`EmptyChatPrompt`、`FullscreenLoading`。
- 不把图标放进标题栏。
- 不单独设 `nsis.installerIcon`（沿用 `win.icon`）。
- 不在 `pnpm package` / `electron-vite build` 里自动生成图标。
- 不处理托盘图标（当前没有托盘）。
- 不改 CLI、不改已移除的 tauri-agent。

## 2. 图形

### 2.1 主 SVG

路径：`electron-agent/build/icon.svg`。

| 项 | 值 |
| --- | --- |
| 画布 | 1024×1024，`viewBox="0 0 1024 1024"` |
| 底 | `#0b0d12` |
| 外轮廓 | `<rect width="1024" height="1024" rx="320" ry="320"/>`（320 / 1024 = 31.25%） |
| 笔画 | `#e6e8ec` |
| π path | `M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z`（与 `PiBrandLogo` 逐字相同） |
| π 几何盒 | 原 path 的紧致盒 `40 56 160 134` |
| 标准内边距 | 每边 20%（内容区 614.4×614.4，居中） |
| π 放置 | 在内容区里 `contain` 后水平垂直居中 |

底色矩形就是图标外形。画布四角透明，不要再包一层不透明方底。

### 2.2 小尺寸补偿

脚本栅格化时：

| 边长 | 每边内边距 |
| --- | --- |
| 16、24 | 12% |
| 32、48、64、128、256、1024 | 20%（与主 SVG 相同） |

16 / 24 不另存 SVG 文件。脚本用与主 SVG 相同的 π path、颜色、圆角比例，只改内边距后栅格化。圆角半径始终是该档边长的 31.25%。

## 3. 生成脚本与产物

### 3.1 脚本

- 路径：`electron-agent/scripts/generate-icons.mjs`
- npm script：`icons` → `node scripts/generate-icons.mjs`
- 工作目录：`electron-agent/`
- `devDependencies`：`sharp`、`png-to-ico`、`png2icons`

流程：读 `build/icon.svg` → 在临时目录写出全部产物 → 校验文件非空 → 再替换目标路径。任一步失败则 `exit 1`、打印路径、不覆盖已有产物。

1024 PNG 由主 SVG 直接栅格化。ico / favicon 的各层按 §2.2 的内边距规则生成 PNG 再打包。icns 由 1024 PNG 经 `png2icons` 生成。

### 3.2 产物（全部入仓）

| 文件 | 内容 |
| --- | --- |
| `electron-agent/build/icon.svg` | §2.1 主文件 |
| `electron-agent/build/icon.png` | 1024×1024 |
| `electron-agent/build/icon.ico` | 16、24、32、48、64、128、256 |
| `electron-agent/build/icon.icns` | 由 1024 PNG 生成 |
| `electron-agent/public/favicon.ico` | 至少含 16 与 32 |
| `electron-agent/public/favicon.png` | 32×32 |

`electron-agent/.gitignore` 已忽略 `resources/`，图标不放那个目录。`build/` 与 `public/` 未被忽略。

改 SVG 或内边距常量后，在 `electron-agent/` 跑 `pnpm icons`，把变更一起提交。

## 4. 接入

### 4.1 electron-builder

`electron-agent/electron-builder.yml`：

```yml
directories:
  output: release
  buildResources: build
files:
  - dist/**
  - out/**
  - package.json
  - build/icon.ico
win:
  icon: build/icon.ico
mac:
  icon: build/icon.icns
linux:
  icon: build/icon.png
```

`files` 只加 `build/icon.ico`：安装包图标由 builder 在打包时从磁盘读取 `win.icon` / `mac.icon` / `linux.icon`，不必打进 asar；运行时窗口只需要 asar 内的 ico。

不设 `nsis.installerIcon`。现有 `asarUnpack`、`afterPack`、各平台 `target` 不动。

### 4.2 运行时窗口

`mainConfig.ts` 新增 `resolveAppIcon(packaged, appPath, mainDir)`。`mainDir` 由 `main.ts` 传入 `__dirname`，避免 `mainConfig` 被打进 `out/main/chunks` 时相对路径漂移：

```ts
export function resolveAppIcon(packaged: boolean, appPath: string, mainDir: string): string {
  if (packaged) return join(appPath, 'build', 'icon.ico');
  return join(mainDir, '../../build/icon.ico');
}
```

`browserWindowOptions` 本身不写死 `icon`（路径依赖打包状态）。`createWindow()`：

```ts
const window = new BrowserWindow({
  ...browserWindowOptions,
  icon: resolveAppIcon(app.isPackaged, app.getAppPath(), __dirname),
});
```

开发时 `main.ts` 编译到 `out/main`，`../../build/icon.ico` 落到 `electron-agent/build/icon.ico`。打包后 `app.getAppPath()` 是 asar 根，与 `files` 里的 `build/icon.ico` 对齐。

Windows、macOS、Linux 都用这一个 `.ico`。Electron 能从 ico 建 `NativeImage`，不按平台再拆窗口图标。

### 4.3 favicon

新建 `electron-agent/public/`（Vite 默认 `publicDir`，renderer `root` 已是 `electron-agent/`）。

`index.html` 的 `<head>` 增加：

```html
<link rel="icon" href="./favicon.ico" />
```

用相对路径，不要用根路径 `/favicon.ico`：开发时 Vite 仍解析到 `public/favicon.ico`；打包后 `createWindow` 走 `loadFile(dist/index.html)`（`file://`），根路径会变成盘符根下的 `favicon.ico`，相对路径才会落到 asar 里的 `dist/favicon.ico`。

## 5. 错误处理

- 源 SVG 缺失、无法解析、sharp / `png-to-ico` / `png2icons` 抛错、写出的文件为空：脚本 `exit 1`，保留旧产物。
- 运行时不包 try/catch。文件若缺失，Electron 回落默认图标；由 §7 的存在性断言拦住。
- `pnpm package` 不调用 `pnpm icons`。图标过期是提交问题，不是打包失败。

## 6. 数据流

```
PiBrandLogo path（手工同步进 icon.svg）
        │
        ▼
build/icon.svg  ──►  generate-icons.mjs
                        ├─ 20% 内边距 → 32..1024 PNG → icon.png / icns / ico 大层
                        └─ 12% 内边距 → 16、24 PNG   → ico 小层 / favicon
        │
        ├─ electron-builder  win/mac/linux.icon
        ├─ resolveAppIcon()  BrowserWindow
        └─ public/favicon.ico  index.html
```

π path 以 `PiBrandLogo.tsx` 为应用内源，以 `build/icon.svg` 为系统图标源。两处 path 字符串必须相同；测试断言两边都含这一段。不在运行时从 React 组件导出 SVG。

## 7. 测试

全部放在现有 Vitest 里，不做截图对比。

1. `icon.svg` 含 π path、`#0b0d12`、`#e6e8ec`、`rx="320"`、`viewBox="0 0 1024 1024"`。
2. `PiBrandLogo.tsx` 与 `icon.svg` 含同一段 π path。
3. `build/icon.ico`、`build/icon.png`、`build/icon.icns`、`public/favicon.ico`、`public/favicon.png` 存在且字节长度大于 0。
4. `electron-builder.yml`：`win.icon` / `mac.icon` / `linux.icon` 为上述路径；`files` 含 `build/icon.ico`；`buildResources` 为 `build`。
5. `resolveAppIcon(false, 'C:\\app.asar', join('C:', 'proj', 'out', 'main'))` 等于 `join('C:', 'proj', 'build', 'icon.ico')`；`resolveAppIcon(true, appPath, mainDir)` 等于 `join(appPath, 'build', 'icon.ico')`，忽略 `mainDir`。
6. `index.html` 含 `rel="icon"` 且 `href` 为 `./favicon.ico`。
7. `browserWindowOptions` 现有安全断言保持；`icon` 不出现在该常量上。

生成脚本本身不进 `pnpm test`（避免测试机必须能跑 sharp 原生模块）。图标文件由实现时生成并提交，测试只读仓库里的产物。

## 8. 文件清单

新增：

- `electron-agent/build/icon.svg`
- `electron-agent/build/icon.png`
- `electron-agent/build/icon.ico`
- `electron-agent/build/icon.icns`
- `electron-agent/public/favicon.ico`
- `electron-agent/public/favicon.png`
- `electron-agent/scripts/generate-icons.mjs`
- `electron-agent/scripts/generate-icons.test.ts`（或放在 `electron/main.config.test.ts` 邻接的图标断言文件）

修改：

- `electron-agent/electron-builder.yml`
- `electron-agent/electron/mainConfig.ts`
- `electron-agent/electron/main.config.test.ts`
- `electron-agent/electron/main.ts`
- `electron-agent/index.html`
- `electron-agent/package.json`（`icons` script 与三个 devDependency）

## 9. 规格自检

- 无「待定 / TODO」占位。圆角、内边距、色值、尺寸、路径、失败行为均已写死。
- §2 的 20% 内边距与 §3 大尺寸栅格化一致；16 / 24 的 12% 只出现在脚本补偿，不写进主 SVG。
- 范围限在 electron-agent 系统图标与 favicon，不扩展到应用内品牌组件。
- `resolveAppIcon` 的 dev 路径以 `main.ts` 的 `__dirname`（`out/main`）为基准，与 `resolveRendererHtml` 的「不要用 out/main/../dist」不冲突：图标在仓库 `build/`，不在 asar 的 `dist/`。
