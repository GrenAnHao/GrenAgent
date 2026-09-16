# Electron `<webview>` 右侧 Dock 迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）来跟踪进度。

**目标：** 在不修改 `tauri-agent` 的前提下，新建 `electron-agent`，迁移现有 React 前端，实现使用 Electron `<webview>` 的右侧 Dock 浏览器，并用 TypeScript/Node 重写 Tauri/Rust 能力以及 Pi、TencentDB 运行时对接。

**架构：** Electron Main 负责窗口、IPC、进程监督和运行时资源；preload 暴露最小的类型化 API；React Renderer 负责现有工作区和右侧 Dock，浏览器内容使用 `<webview>` 标签。现有 Tauri 工程保持独立，Pi 和 TencentDB 作为 Electron 资源目录中的受监督子进程运行。

**技术栈：** Electron、TypeScript、React 19、Vite、electron-vite、electron-builder、Bun、Vitest、Testing Library、`<webview>`、Node `child_process`、`node-pty`、`better-sqlite3`、`keytar`。

---

## 文件清单

### 新建文件

- `electron-agent/package.json`：Electron 工程脚本和依赖。
- `electron-agent/electron/main.ts`：主进程入口和 BrowserWindow 创建。
- `electron-agent/electron/mainConfig.ts`：可在 Node 测试环境加载的窗口配置。
- `electron-agent/electron/preload.ts`：安全的 Renderer API 桥接。
- `electron-agent/electron/ipc/contracts.ts`：IPC 请求、响应和事件类型。
- `electron-agent/electron/ipc/registry.ts`：IPC handler 注册表。
- `electron-agent/electron/browser/webviewPolicy.ts`：`<webview>` attach、导航、权限策略。
- `electron-agent/electron/runtime/runtimePaths.ts`：开发和打包环境的运行时路径。
- `electron-agent/electron/runtime/processSupervisor.ts`：子进程启动、健康检查和退出清理。
- `electron-agent/electron/runtime/piRpc.ts`：Pi JSONL RPC framing 和请求管理。
- `electron-agent/electron/runtime/piRuntime.ts`：Pi sidecar 生命周期。
- `electron-agent/electron/runtime/tencentdbRuntime.ts`：TencentDB Core、Knowledge、Panel 生命周期。
- `electron-agent/electron/packageResources.ts`：打包资源清单。
- `electron-agent/electron/services/files.ts`：文件和 workspace containment 能力。
- `electron-agent/electron/services/git.ts`：Git 命令能力。
- `electron-agent/electron/services/terminal.ts`：PTY 终端能力。
- `electron-agent/electron/services/credentials.ts`：系统凭据存取。
- `electron-agent/electron/services/database.ts`：SQLite 访问。
- `electron-agent/src/platform/runtime.ts`：Renderer 侧桌面能力接口。
- `electron-agent/src/platform/electronRuntime.ts`：preload API 的 Renderer 适配器。
- `electron-agent/src/features/dock/BrowserPanel.tsx`：右 Dock 浏览器 UI。
- `electron-agent/src/features/dock/browserStore.ts`：浏览器 Tab 状态。
- `electron-agent/src/features/dock/browserTypes.ts`：浏览器 Tab 和页面状态类型。
- `electron-agent/src/features/dock/browserStyles.ts`：浏览器 DOM 行布局样式。
- `electron-agent/src/types/webview.d.ts`：React `<webview>` JSX 类型声明。
- `electron-agent/electron/**/*.test.ts`、`electron-agent/src/**/*.test.tsx`：对应单元和组件测试。
- `electron-agent/electron-builder.yml`：打包资源、asar unpack 和平台配置。

### 从现有项目拷贝的文件

- `tauri-agent/src/**` → `electron-agent/src/**`，作为 React 前端迁移基线。
- `tauri-agent/index.html` → `electron-agent/index.html`。
- `tauri-agent/public/**`（如果存在）→ `electron-agent/public/**`。
- `tauri-agent/src/assets/**` → `electron-agent/src/assets/**`。
- `tauri-agent/src/theme/**` → `electron-agent/src/theme/**`。
- `tauri-agent/scripts/build-sidecar.mjs` → `electron-agent/scripts/build-sidecar.mjs`，只调整资源根路径。
- `tauri-agent/scripts/build-tencentdb-memory.mjs` → `electron-agent/scripts/build-tencentdb-memory.mjs`，保留版本和摘要校验。
- 根目录 `cli/**`、`extensions/**` 的构建输入按脚本需要作为只读资源源，不复制 Tauri Rust 代码。

### 明确不修改的文件

- `tauri-agent/**` 中的所有源代码、配置、依赖和锁文件。
- 根目录已有的 `cli`、`extensions` 和其他未参与本次新工程的工作区改动。

---

### 任务 1：创建 Electron 工程骨架

**文件：**
- 创建：`electron-agent/package.json`
- 创建：`electron-agent/tsconfig.json`
- 创建：`electron-agent/tsconfig.node.json`
- 创建：`electron-agent/vite.config.ts`
- 创建：`electron-agent/electron.vite.config.ts`
- 创建：`electron-agent/index.html`
- 创建：`electron-agent/electron/main.ts`
- 创建：`electron-agent/electron/mainConfig.ts`
- 创建：`electron-agent/electron/preload.ts`
- 测试：`electron-agent/electron/main.config.test.ts`

- [ ] **步骤 1：编写工程配置测试**

```ts
import { describe, expect, it } from 'vitest';
import { browserWindowOptions } from './mainConfig';

describe('browser window options', () => {
  it('enables the webview tag without enabling Node in renderer pages', () => {
    expect(browserWindowOptions.webPreferences).toMatchObject({
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });
});
```

- [ ] **步骤 2：运行测试确认骨架测试失败**

运行：`cd electron-agent; bunx vitest run electron/main.config.test.ts`

预期：FAIL，报错 `Cannot find module './main'`。

- [ ] **步骤 3：创建最小工程配置和窗口入口**

`package.json` 至少包含以下脚本和依赖：

```json
{
  "name": "grenagent-electron",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "tsc -p tsconfig.json && electron-vite build",
    "test": "vitest run",
    "build:sidecar": "node scripts/build-sidecar.mjs",
    "build:tencentdb-memory": "node scripts/build-tencentdb-memory.mjs",
    "package": "electron-builder --config electron-builder.yml"
  },
  "dependencies": {
    "electron": "^38.0.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@types/node": "^22.15.30",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "electron-builder": "^26.0.12",
    "electron-vite": "^4.0.0",
    "@vitejs/plugin-react": "^6.0.5",
    "jsdom": "^26.1.0",
    "typescript": "7.0.2",
    "vite": "^7.1.7",
    "vitest": "^3.2.4"
  }
}
```

React 组件直接由任务 2 拷贝到 `src`，不建立虚构的本地 UI 包依赖。

`electron/mainConfig.ts` 导出纯数据 `browserWindowOptions`，`electron/main.ts` 导入该配置创建 `BrowserWindow`：

```ts
import { join } from 'node:path';

export const browserWindowOptions: Electron.BrowserWindowConstructorOptions = {
  width: 1200,
  height: 800,
  minWidth: 720,
  minHeight: 520,
  webPreferences: {
    preload: join(__dirname, 'preload.mjs'),
    webviewTag: true,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
};
```

- [ ] **步骤 4：运行测试确认窗口安全配置通过**

运行：`cd electron-agent; bunx vitest run electron/main.config.test.ts`

预期：PASS。

- [ ] **步骤 5：提交工程骨架**

```bash
git add electron-agent
git commit -m "feat(工程): 创建 Electron TypeScript 工程骨架"
```

---

### 任务 2：迁移 React 前端快照并建立平台接口

**文件：**
- 创建：`electron-agent/src/**`（从 `tauri-agent/src/**` 拷贝）
- 创建：`electron-agent/index.html`
- 创建：`electron-agent/src/platform/runtime.ts`
- 创建：`electron-agent/src/platform/electronRuntime.ts`
- 创建：`electron-agent/src/platform/runtime.test.ts`
- 创建：`electron-agent/docs/tauri-api-inventory.md`
- 修改：`electron-agent/src/main.tsx`
- 修改：`electron-agent/src/lib/*.ts` 中的 Tauri import

- [ ] **步骤 1：拷贝前端并记录 Tauri 依赖清单**

运行：

```powershell
Copy-Item -Recurse -Force ..\tauri-agent\src .\electron-agent\src
Copy-Item -Force ..\tauri-agent\index.html .\electron-agent\index.html
if (Test-Path ..\tauri-agent\public) { Copy-Item -Recurse -Force ..\tauri-agent\public .\electron-agent\public }
```

在 `electron-agent/docs/tauri-api-inventory.md` 记录以下现有调用点：

```text
@tauri-apps/api/core       → ipc invoke adapter
@tauri-apps/api/event      → event subscription adapter
@tauri-apps/api/window     → BrowserWindow adapter
@tauri-apps/api/webview    → webview element adapter
plugin-dialog              → electron dialog adapter
plugin-opener              → electron shell adapter
```

将 `tauri-agent/package.json` 中除 `@tauri-apps/*` 和 `@tauri-apps/cli` 之外的依赖合并到新工程，至少包括 `@base-ui/react`、`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`@lexical/utils`、`@lobehub/charts`、`@lobehub/editor`、`@lobehub/ui`、`antd`、`antd-style`、`beautiful-mermaid`、`lexical`、`mermaid`、`motion`、`lucide-react`、`react-hotkeys-hook`、`virtua`、`xterm`、`xterm-addon-fit` 和 `zustand`。保留 React 19.2.8 的 overrides，确保安装树只有一份 React。

- [ ] **步骤 2：编写平台接口测试**

```ts
import { describe, expect, it } from 'vitest';
import type { DesktopRuntime } from './runtime';

describe('DesktopRuntime contract', () => {
  it('exposes typed invoke, events and external actions', () => {
    const keys: Array<keyof DesktopRuntime> = ['invoke', 'on', 'openExternal'];
    expect(keys).toEqual(['invoke', 'on', 'openExternal']);
  });
});
```

- [ ] **步骤 3：定义最小平台接口并替换复制代码中的直接 Tauri import**

```ts
export interface DesktopRuntime {
  invoke<T>(command: string, payload?: unknown): Promise<T>;
  on<T>(event: string, handler: (payload: T) => void): () => void;
  openExternal(target: string): Promise<void>;
  openPath(target: string): Promise<void>;
  showOpenDialog(options: unknown): Promise<unknown>;
}
```

`electronRuntime.ts` 从 `window.gren` 获取实现；复制的 `lib/pi.ts`、`lib/files.ts`、`lib/workspace.ts`、`lib/terminal.ts`、`lib/tencentdb.ts`、`lib/skillsIo.ts` 和使用 opener/dialog 的组件全部改用该接口。此阶段只替换调用入口，不实现后端 handler。

- [ ] **步骤 4：运行前端 TypeScript 检查**

运行：`cd electron-agent; bun run build`

预期：只允许出现尚未实现的 IPC 类型错误；不得再出现 `Cannot find module '@tauri-apps/...`。将剩余错误按任务 3–10 的服务分类记录到 `docs/tauri-api-inventory.md`。

- [ ] **步骤 5：提交前端快照和平台接口**

```bash
git add electron-agent
git commit -m "feat(前端): 迁移 React 快照并抽象桌面能力"
```

---

### 任务 3：建立类型化 IPC 合同和 preload 桥接

**文件：**
- 创建：`electron-agent/electron/ipc/contracts.ts`
- 创建：`electron-agent/electron/ipc/registry.ts`
- 修改：`electron-agent/electron/preload.ts`
- 修改：`electron-agent/src/platform/electronRuntime.ts`
- 测试：`electron-agent/electron/ipc/contracts.test.ts`
- 测试：`electron-agent/electron/ipc/registry.test.ts`

- [ ] **步骤 1：编写非法输入测试**

```ts
import { describe, expect, it } from 'vitest';
import { BrowserOpenRequest, parseCommandRequest } from './contracts';

describe('IPC contracts', () => {
  it('rejects browser URLs without http or https', () => {
    expect(() => BrowserOpenRequest.parse({ url: 'file:///secret' })).toThrow();
  });

  it('rejects unknown commands', () => {
    expect(() => parseCommandRequest('unknown.command', {})).toThrow();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; bunx vitest run electron/ipc/contracts.test.ts`

预期：FAIL，报错 `Cannot find module './contracts'`。

- [ ] **步骤 3：实现合同和最小桥接**

合同至少包含：

```ts
export const BrowserOpenRequest = z.object({
  url: z.string().url().refine((url) => /^https?:$/.test(new URL(url).protocol)),
  partition: z.string().regex(/^persist:[a-z0-9-]+$/).optional(),
});

export type IpcCommand =
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.close'
  | 'runtime.status'
  | 'files.read'
  | 'files.write'
  | 'workspace.list'
  | 'git.run'
  | 'terminal.create'
  | 'pi.request'
  | 'tencentdb.status';
```

`preload.ts` 只暴露固定方法，不暴露原始 `ipcRenderer`：

```ts
contextBridge.exposeInMainWorld('gren', {
  invoke: <T>(command: IpcCommand, payload?: unknown) => ipcRenderer.invoke(command, payload) as Promise<T>,
  on: (event: string, listener: (payload: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
  openExternal: (target: string) => ipcRenderer.invoke('shell.openExternal', target),
  openPath: (target: string) => ipcRenderer.invoke('shell.openPath', target),
  showOpenDialog: (options: unknown) => ipcRenderer.invoke('dialog.open', options),
});
```

`parseCommandRequest` 使用 `IpcCommand` 到 Zod schema 的显式映射，未知 command 直接抛出错误；不得使用按字符串拼接 schema 的动态回退。

- [ ] **步骤 4：运行 IPC 测试确认通过**

运行：`cd electron-agent; bunx vitest run electron/ipc`

预期：PASS。

- [ ] **步骤 5：提交 IPC 基础层**

```bash
git add electron-agent
git commit -m "feat(通信): 建立 Electron 类型化 IPC 桥接"
```

---

### 任务 4：实现右侧 Dock 的 `<webview>` 浏览器

**文件：**
- 创建：`electron-agent/src/features/dock/browserTypes.ts`
- 创建：`electron-agent/src/features/dock/browserStore.ts`
- 创建：`electron-agent/src/features/dock/BrowserPanel.tsx`
- 创建：`electron-agent/src/features/dock/browserStyles.ts`
- 创建：`electron-agent/src/types/webview.d.ts`
- 修改：`electron-agent/src/features/dock/DockPanel.tsx`
- 修改：`electron-agent/src/stores/dockStore.ts`
- 测试：`electron-agent/src/features/dock/browserStore.test.ts`
- 测试：`electron-agent/src/features/dock/BrowserPanel.test.tsx`

- [ ] **步骤 1：编写 Tab 状态和布局测试**

```ts
import { describe, expect, it } from 'vitest';
import { createBrowserTab, browserPanelRows } from './browserStore';

describe('browser dock', () => {
  it('creates a browser tab with a persistent partition', () => {
    expect(createBrowserTab('https://example.com')).toMatchObject({
      url: 'https://example.com',
      partition: 'persist:grenagent-browser',
      loading: false,
    });
  });

  it('reserves separate DOM rows before webview content', () => {
    expect(browserPanelRows).toBe('38px 40px 42px minmax(0, 1fr)');
  });
});
```

`BrowserPanel.test.tsx` 使用自定义 `webview` mock，验证工具栏、浏览器 Tab 和 `<webview>` 同时存在，并且 `<webview>` 的容器 class 为 `browser-content`。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; bunx vitest run src/features/dock/browserStore.test.ts src/features/dock/BrowserPanel.test.tsx`

预期：FAIL，报错 `Cannot find module './browserStore'`。

- [ ] **步骤 3：实现浏览器状态和 React UI**

定义类型：

```ts
export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  partition: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}
```

`BrowserPanel` 必须使用以下固定结构：

```tsx
<section className={styles.panel}>
  <div className={styles.dockTabs}>{/* 现有 Dock TabStrip */}</div>
  <div className={styles.browserTabs}>{/* 网页标签 */}</div>
  <div className={styles.toolbar}>{/* 后退、前进、刷新、地址栏、菜单 */}</div>
  <div className={styles.content}>
    <webview
      ref={webviewRef}
      src={active.url}
      partition={active.partition}
      allowpopups="false"
      webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
    />
  </div>
</section>
```

`browserStyles.ts` 使用 `grid-template-rows: 38px 40px 42px minmax(0, 1fr)`，禁止 `<webview>` 使用覆盖整个 Dock 的绝对定位。右 Dock 宽度继续使用现有 200–800 px 约束。

- [ ] **步骤 4：运行浏览器组件测试确认通过**

运行：`cd electron-agent; bunx vitest run src/features/dock/browserStore.test.ts src/features/dock/BrowserPanel.test.tsx`

预期：PASS。

- [ ] **步骤 5：提交右 Dock 浏览器 UI**

```bash
git add electron-agent
git commit -m "feat(浏览器): 添加右 Dock WebView 标签界面"
```

---

### 任务 5：实现 `<webview>` 生命周期和安全策略

**文件：**
- 创建：`electron-agent/electron/browser/webviewPolicy.ts`
- 修改：`electron-agent/electron/main.ts`
- 修改：`electron-agent/src/features/dock/BrowserPanel.tsx`
- 测试：`electron-agent/electron/browser/webviewPolicy.test.ts`
- 测试：`electron-agent/src/features/dock/BrowserPanel.lifecycle.test.tsx`

- [ ] **步骤 1：编写 attach、导航和弹窗拦截测试**

```ts
import { describe, expect, it } from 'vitest';
import { validateWebviewAttach, shouldAllowNavigation, isAllowedPanelEndpoint } from './webviewPolicy';

describe('webview policy', () => {
  it('rejects a webview preload supplied by a remote page', () => {
    expect(validateWebviewAttach({ preload: 'https://evil.test/preload.js' })).toBe(false);
  });

  it('allows http and https navigation only', () => {
    expect(shouldAllowNavigation('https://example.com')).toBe(true);
    expect(shouldAllowNavigation('file:///secret')).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; bunx vitest run electron/browser/webviewPolicy.test.ts`

预期：FAIL，报错 `Cannot find module './webviewPolicy'`。

- [ ] **步骤 3：实现策略和生命周期**

Main 进程监听 `will-attach-webview`，清空远程传入的 preload，校验 partition 和 URL，并拒绝未知 partition。Renderer 监听以下 `<webview>` 事件并同步 `BrowserTabState`：

```text
did-start-loading
did-stop-loading
page-title-updated
did-navigate
did-navigate-in-page
did-fail-load
new-window
ipc-message
```

浏览器页面默认只允许导航，不注入应用 API。只有 `http://127.0.0.1:<panel-port>` 的受信任 TencentDB Panel 页面进入明确的 `trustedPanel` 模式。

标签切换只隐藏非活动 `<webview>`，不销毁节点；关闭标签才移除节点并调用对应清理逻辑。`postMessage` 仅用于受信任 Panel，普通远程网页不获得宿主消息通道。

- [ ] **步骤 4：运行策略和生命周期测试**

运行：`cd electron-agent; bunx vitest run electron/browser src/features/dock/BrowserPanel.lifecycle.test.tsx`

预期：PASS。

- [ ] **步骤 5：提交 WebView 安全层**

```bash
git add electron-agent
git commit -m "feat(浏览器): 增加 WebView 生命周期和安全策略"
```

---

### 任务 6：实现运行时路径和通用进程监督

**文件：**
- 创建：`electron-agent/electron/runtime/runtimePaths.ts`
- 创建：`electron-agent/electron/runtime/processSupervisor.ts`
- 测试：`electron-agent/electron/runtime/runtimePaths.test.ts`
- 测试：`electron-agent/electron/runtime/processSupervisor.test.ts`

- [ ] **步骤 1：编写开发/打包路径测试**

```ts
import { describe, expect, it } from 'vitest';
import { runtimeRoot } from './runtimePaths';

describe('runtime paths', () => {
  it('uses resources/runtime in packaged mode', () => {
    expect(runtimeRoot({ packaged: true, resourcesPath: 'C:/app/resources' }))
      .toBe('C:/app/resources/runtime');
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; bunx vitest run electron/runtime/runtimePaths.test.ts`

预期：FAIL，报错 `Cannot find module './runtimePaths'`。

- [ ] **步骤 3：实现路径和监督器**

运行时路径规则：

```text
开发：electron-agent/resources/runtime
打包：process.resourcesPath/runtime
```

`ProcessSupervisor` 提供固定方法：

```ts
export interface ProcessSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ManagedProcess {
  name: string;
  pid: number;
  child: import('node:child_process').ChildProcess;
}

export type HealthCheck = () => Promise<void>;

start(spec: ProcessSpec): Promise<ManagedProcess>;
waitForHealthy(process: ManagedProcess, check: HealthCheck): Promise<void>;
stop(process: ManagedProcess): Promise<void>;
stopAll(): Promise<void>;
```

监督器记录 PID、退出码、stderr 摘要和健康状态；退出时先停止接收新请求，再按逆序停止 Panel、Knowledge、Core、Pi 和 PTY。Windows 使用 `taskkill /pid <pid> /t /f` 清理进程树，Unix 使用进程组信号，所有命令参数使用数组传递。

- [ ] **步骤 4：运行运行时基础测试**

运行：`cd electron-agent; bunx vitest run electron/runtime`

预期：PASS。

- [ ] **步骤 5：提交运行时基础层**

```bash
git add electron-agent
git commit -m "feat(运行时): 添加资源路径和进程监督"
```

---

### 任务 7：迁移 Pi sidecar 和 RPC

**文件：**
- 创建：`electron-agent/electron/runtime/piRpc.ts`
- 创建：`electron-agent/electron/runtime/piRuntime.ts`
- 修改：`electron-agent/electron/ipc/registry.ts`
- 修改：`electron-agent/src/lib/pi.ts`
- 测试：`electron-agent/electron/runtime/piRpc.test.ts`
- 测试：`electron-agent/electron/runtime/piRuntime.test.ts`

- [ ] **步骤 1：编写 JSONL framing 测试**

```ts
import { describe, expect, it } from 'vitest';
import { decodeJsonLines, encodeJsonLine } from './piRpc';

describe('Pi JSONL RPC', () => {
  it('encodes one JSON object per line', () => {
    expect(encodeJsonLine({ type: 'prompt', text: 'hi' })).toBe('{"type":"prompt","text":"hi"}\\n');
  });

  it('keeps partial chunks until a newline arrives', () => {
    expect(decodeJsonLines('{"id":1}\\n{"id":2}')).toEqual({
      messages: [{ id: 1 }],
      remainder: '{"id":2}',
    });
  });
});
```

- [ ] **步骤 2：运行 RPC 测试确认失败**

运行：`cd electron-agent; bunx vitest run electron/runtime/piRpc.test.ts`

预期：FAIL，报错 `Cannot find module './piRpc'`。

- [ ] **步骤 3：实现 Pi 运行时**

`PiRuntime` 从 `runtimePaths().pi` 启动现有 sidecar，复用 `build-sidecar.mjs` 生成的协议；实现请求 ID、超时、stdin 写入、stdout JSONL 解析、stderr 摘要、退出重连和事件广播。Renderer 的 `src/lib/pi.ts` 改为通过 `window.gren.invoke('pi.request', ...)` 和 `window.gren.on('pi.event', ...)` 通信。

- [ ] **步骤 4：运行 Pi 测试**

运行：`cd electron-agent; bunx vitest run electron/runtime/piRpc.test.ts electron/runtime/piRuntime.test.ts`

预期：PASS。

- [ ] **步骤 5：提交 Pi 对接**

```bash
git add electron-agent
git commit -m "feat(Pi): 用 TypeScript 接入 sidecar RPC"
```

---

### 任务 8：迁移 TencentDB Core、Knowledge 和 Panel

**文件：**
- 创建：`electron-agent/electron/runtime/tencentdbRuntime.ts`
- 创建：`electron-agent/electron/services/tencentdbCore.ts`
- 创建：`electron-agent/electron/services/tencentdbKnowledge.ts`
- 修改：`electron-agent/scripts/build-tencentdb-memory.mjs`
- 修改：`electron-agent/electron/ipc/registry.ts`
- 修改：`electron-agent/src/lib/tencentdb.ts`
- 修改：`electron-agent/src/features/tencentdb/ConnectionSettings.tsx`
- 测试：`electron-agent/electron/services/tencentdbCore.test.ts`
- 测试：`electron-agent/electron/services/tencentdbKnowledge.test.ts`
- 测试：`electron-agent/electron/runtime/tencentdbRuntime.test.ts`

- [ ] **步骤 1：编写 endpoint、鉴权和健康检查测试**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeTencentDbEndpoint } from './tencentdbCore';

describe('TencentDB client', () => {
  it('normalizes a trailing /v3 without duplicating it', () => {
    expect(normalizeTencentDbEndpoint('http://127.0.0.1:8421/v3'))
      .toBe('http://127.0.0.1:8421');
  });

  it('rejects non-loopback local Panel endpoints', () => {
    expect(isAllowedPanelEndpoint('http://example.com:8421')).toBe(false);
  });
});
```

- [ ] **步骤 2：运行 TencentDB 测试确认失败**

运行：`cd electron-agent; bunx vitest run electron/services/tencentdbCore.test.ts`

预期：FAIL，报错 `Cannot find module './tencentdbCore'`。

- [ ] **步骤 3：迁移构建和运行时启动**

保留现有脚本中的上游 owner、repo、commit、Node 版本、SHA-256 和 manifest 校验。Electron 版本只把输出根改为 `electron-agent/resources/runtime/tencentdb-memory/<platform>`，并由 `runtimePaths.ts` 读取。

`TencentDbRuntime` 按以下顺序启动并健康检查：

```text
Core → Knowledge → Panel
```

Panel 只监听 loopback，使用现有端口文件和 shared secret 流程。Main 为受信任 Panel 生成一次性 bootstrap URL，再通过 `browser.open` 返回给右 Dock `<webview>`。凭据只保存在 Main 服务，不进入 Renderer 普通状态。

- [ ] **步骤 4：运行 TencentDB 单元和运行时测试**

运行：`cd electron-agent; bunx vitest run electron/services/tencentdbCore.test.ts electron/services/tencentdbKnowledge.test.ts electron/runtime/tencentdbRuntime.test.ts`

预期：PASS。

- [ ] **步骤 5：提交 TencentDB 对接**

```bash
git add electron-agent
git commit -m "feat(TencentDB): 接入 Core Knowledge Panel 运行时"
```

---

### 任务 9：重写文件、Workspace、Git、终端、数据库和凭据服务

**文件：**
- 创建：`electron-agent/electron/services/files.ts`
- 创建：`electron-agent/electron/services/git.ts`
- 创建：`electron-agent/electron/services/terminal.ts`
- 创建：`electron-agent/electron/services/database.ts`
- 创建：`electron-agent/electron/services/credentials.ts`
- 修改：`electron-agent/electron/ipc/registry.ts`
- 修改：`electron-agent/src/lib/files.ts`
- 修改：`electron-agent/src/lib/workspace.ts`
- 修改：`electron-agent/src/lib/terminal.ts`
- 修改：`electron-agent/src/lib/mcpPolicyIo.ts`
- 修改：`electron-agent/src/lib/skillsIo.ts`
- 修改：`electron-agent/src/features/dock/TerminalBody.tsx`
- 测试：`electron-agent/electron/services/files.test.ts`
- 测试：`electron-agent/electron/services/git.test.ts`
- 测试：`electron-agent/electron/services/terminal.test.ts`
- 测试：`electron-agent/electron/services/database.test.ts`
- 测试：`electron-agent/electron/services/credentials.test.ts`

- [ ] **步骤 1：编写路径和命令注入测试**

```ts
import { describe, expect, it } from 'vitest';
import { assertWorkspacePath } from './files';
import { buildGitArgs } from './git';

describe('native services', () => {
  it('rejects paths outside the selected workspace', () => {
    expect(() => assertWorkspacePath('C:/repo', 'C:/repo/../secret.txt')).toThrow();
  });

  it('passes Git arguments as separate argv values', () => {
    expect(buildGitArgs(['status', '--short'])).toEqual(['status', '--short']);
  });
});
```

- [ ] **步骤 2：运行服务测试确认失败**

运行：`cd electron-agent; bunx vitest run electron/services`

预期：FAIL，报错 `Cannot find module`。

- [ ] **步骤 3：实现服务**

实现约束：

- 文件服务将目标路径规范化后限制在 workspace 根目录内，拒绝 symbolic link 越界。
- Git 使用 `spawn('git', args, { cwd })`，不拼接 shell 字符串。
- 终端使用 `node-pty`，向 Renderer 广播输出并在关闭时释放 PTY。
- SQLite 使用 `better-sqlite3`，数据库文件位于 Electron userData 目录。
- 凭据使用 `keytar`，不把 API key 写入 Renderer store、日志或 URL。
- 对话框和外部打开继续由 IPC handler 统一调用 Electron `dialog`、`shell`。

- [ ] **步骤 4：运行服务测试确认通过**

运行：`cd electron-agent; bunx vitest run electron/services`

预期：PASS。

- [ ] **步骤 5：提交 Node 服务重写**

```bash
git add electron-agent
git commit -m "feat(服务): 用 TypeScript 重写文件终端和系统能力"
```

---

### 任务 10：注册全部 IPC handler 并完成前端对接

**文件：**
- 修改：`electron-agent/electron/ipc/registry.ts`
- 修改：`electron-agent/electron/main.ts`
- 修改：`electron-agent/src/platform/electronRuntime.ts`
- 修改：`electron-agent/src/features/**`
- 修改：`electron-agent/src/lib/**`
- 测试：`electron-agent/electron/ipc/registry.integration.test.ts`
- 测试：`electron-agent/src/platform/electronRuntime.integration.test.ts`

- [ ] **步骤 1：编写 handler 注册覆盖测试**

```ts
import { describe, expect, it } from 'vitest';
import { registeredCommands } from './registry';

describe('IPC registry', () => {
  it('registers every command used by the migrated frontend', () => {
    expect(registeredCommands).toEqual(expect.arrayContaining([
      'browser.open', 'browser.navigate', 'browser.close',
      'runtime.status', 'files.read', 'files.write', 'workspace.list',
      'git.run', 'terminal.create', 'pi.request', 'tencentdb.status',
    ]));
  });
});
```

- [ ] **步骤 2：实现 handler 注册和错误模型**

每个 handler 使用合同 parser 校验输入，将内部异常映射为 `{ code, message }`，用户可见信息不得包含 token、完整命令行或敏感本地路径。注册服务包括 Browser、Runtime、Files、Workspace、Git、Terminal、Pi 和 TencentDB。

- [ ] **步骤 3：删除新工程中的全部 Tauri import**

运行：`rg -n "@tauri-apps|tauri-plugin" electron-agent`

预期：无输出。不得修改原 `tauri-agent` 中对应内容。

- [ ] **步骤 4：运行前端和 IPC 全量测试**

运行：`cd electron-agent; bun run test`

预期：所有 Electron 单元和 React 组件测试通过。

- [ ] **步骤 5：提交前端对接**

```bash
git add electron-agent
git commit -m "feat(对接): 完成 Renderer 与 Electron 服务连接"
```

---

### 任务 11：配置资源打包和跨平台启动

**文件：**
- 创建：`electron-agent/electron-builder.yml`
- 创建：`electron-agent/electron/packageResources.ts`
- 修改：`electron-agent/package.json`
- 修改：`electron-agent/scripts/build-sidecar.mjs`
- 修改：`electron-agent/scripts/build-tencentdb-memory.mjs`
- 创建：`electron-agent/electron/packageResources.test.ts`

- [ ] **步骤 1：编写资源布局测试**

```ts
import { describe, expect, it } from 'vitest';
import { requiredRuntimeFiles } from './packageResources';

describe('packaged runtime layout', () => {
  it('requires Pi, Node and TencentDB entry files', () => {
    expect(requiredRuntimeFiles).toEqual(expect.arrayContaining([
      'runtime/pi',
      'runtime/node/node.exe',
      'runtime/tencentdb-memory/manifest.json',
    ]));
  });
});
```

- [ ] **步骤 2：配置 Electron Builder**

`electron-builder.yml` 必须声明：

```yaml
asar: true
asarUnpack:
  - resources/runtime/pi/**
  - resources/runtime/node/**
  - resources/runtime/tencentdb-memory/**
extraResources:
  - from: resources/runtime
    to: runtime
```

`electron/packageResources.ts` 导出跨平台清单生成器，Windows 使用 `runtime/node/node.exe`，macOS/Linux 使用 `runtime/node/bin/node`，并始终要求 `runtime/pi`、`runtime/tencentdb-memory/manifest.json`、`runtime/tencentdb-memory/core`、`runtime/tencentdb-memory/knowledge` 和 `runtime/tencentdb-memory/panel` 存在。

根据目标平台将 Pi sidecar 命名为对应 target triple，并保留现有 Node 运行时和 TencentDB manifest 摘要。

- [ ] **步骤 3：运行资源构建和布局验证**

运行：

```bash
cd electron-agent
bun run build:sidecar
bun run build:tencentdb-memory -- --verify
bun run build
```

预期：生成 `resources/runtime`，manifest 校验通过，Electron 主进程构建通过。

- [ ] **步骤 4：提交打包配置**

```bash
git add electron-agent
git commit -m "chore(打包): 配置 Electron 运行时资源"
```

---

### 任务 12：端到端验证右 Dock 和运行时生命周期

**文件：**
- 创建：`electron-agent/tests/e2e/browser-dock.spec.ts`
- 创建：`electron-agent/tests/e2e/runtime.spec.ts`
- 修改：`electron-agent/package.json`
- 修改：`electron-agent/electron/main.ts`

- [ ] **步骤 1：编写 Electron E2E 测试**

测试必须覆盖：

```text
1. 启动 Electron 并打开右 Dock。
2. 创建浏览器 Tab 并加载测试 HTTP 页面。
3. 验证 Dock TabStrip、地址栏和菜单的 boundingClientRect 不与 webview 内容矩形相交。
4. 调整右 Dock 宽度，验证 webview 宽高同步。
5. 切换浏览器 Tab，再切回时页面状态仍存在。
6. 打开 TencentDB Panel 测试 fixture，验证 bootstrap 后页面可加载。
7. 关闭应用，验证 Pi、Panel、Knowledge 和 Core 进程均已退出。
```

- [ ] **步骤 2：运行 E2E 测试确认失败或缺少 fixture**

运行：`cd electron-agent; bun run test:e2e`

预期：在功能尚未全部实现时失败；失败信息必须对应具体测试步骤，不允许只输出超时。

- [ ] **步骤 3：完成测试 fixture 和启动脚本**

提供本地测试 HTTP 页面和固定端口健康 fixture；E2E 使用临时 userData 目录，禁止读取开发者真实 Cookie、凭据和工作区。

- [ ] **步骤 4：运行完整验证**

运行：

```bash
cd electron-agent
bun run test
bun run build
bun run test:e2e
bun run package
```

预期：单元测试、TypeScript 构建、E2E 和打包全部通过；干净环境启动不依赖系统 Node。

- [ ] **步骤 5：核对原 Tauri 工程未被修改**

运行：`git diff -- tauri-agent`

预期：输出为空。工作区中原本存在的其他未提交变更不得被恢复、覆盖或提交。

- [ ] **步骤 6：提交最终验证结果**

```bash
git add electron-agent
git commit -m "test(迁移): 验证 Electron 浏览器和运行时集成"
```
