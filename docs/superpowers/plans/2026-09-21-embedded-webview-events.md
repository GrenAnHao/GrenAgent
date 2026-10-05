# 内置 `<webview>` 事件接管 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 拆掉 guest click 劫持；`target=_blank` / `window.open` 由 main `setWindowOpenHandler` 路由到同坞新浏览器 tab（Ctrl/Cmd 或 `background-tab` 走系统浏览器）；对齐 ZCode 的 webview 事件面（失败、崩溃重建、guest 登记）。

**架构：** 可测纯函数放在 `electron/browser/`（白名单、popup 判定、guest 表）。`attachEmbeddedWebview(embedder)` 挂到窗口。Renderer 经 `invoke('browser_attach_guest')` 登记、`listen('browser-open-url')` 开 tab。`BrowserBody` 迁到 `src/features/dock/browser/`，不再听 `new-window`。

**技术栈：** Electron 38、TypeScript 7、React 19.2、Vitest 4、Testing Library。

**规格：** `docs/superpowers/specs/2026-09-21-embedded-webview-events-design.md`

**硬约束：**

- TDD。不要隔离 worktree，在当前仓库原地做。
- 每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。用户未要求提交则跳过各任务的 Commit 步骤。
- 禁止 emoji。不要做 JS 对话框桥、滚轮续接、DevTools 菜单、CDP、claim。
- 不要把 popup 开在当前 webview 里。不要保留 `nativeWindowOpen=no` 或 `new-window` 监听。
- `allowpopups` 以 JSX 属性为主路径，且**必须写成字符串** `allowpopups="true"`：React 对未知属性的布尔值会直接 `removeAttribute`（`react-dom` 的 `setValueForAttribute` 在 `typeof value === "boolean"` 且名字非 `data-`/`aria-` 时删除），写 `{true}` 会让属性消失、`window.open` 被 Chromium 静默吞掉、`setWindowOpenHandler` 根本不触发。`applyWillAttachPolicy` **不删除、不写回** `params.allowpopups`。
- guest 命令名必须是 `browser_attach_guest` / `browser_detach_guest`（snake_case）。事件名 `browser-open-url`。
- `render-process-gone` 的可恢复集合不含 `clean-exit`、`launch-failed`、`integrity-failure`，也不要发明 `memory-eviction`。
- 主进程单测骨架对齐 `electron/devtoolsShortcut.test.ts`（`vi.mock('electron')` + 假 WebContents + 手动派发）。

**测试命令（Windows）：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务测试文件>
```

---

## 动工前必读

- 当前 `isAllowedWebviewUrl` 放行整个 `about:`。规格只允许精确 `about:blank`。迁测时要把「其它 about 被拒」写进去。
- `setWindowOpenHandler` 必须永远 `{ action: "deny" }`，再按判定外开或 IPC。不要 `action: "allow"`。
- `did-attach` 是无载荷 DOM 事件。`webContentsId` 来自 `<webview>.getWebContentsId()`。接线 effect 跑完后补登记一次。
- 给 `<webview>` 换 `key` 不会重跑只依赖 `tab.id` 的 effect。重建代号必须进 effect 依赖；首挂 URL 的 ref 必须在重建时复位。
- popup tab id 禁止 `browser-${Date.now()}`。用导出的 `uniqueId` + 递增 nonce（见任务 7）。
- `listen('browser-open-url')` 挂在 `DockDndProvider`（两坞共用且 VisualPanel 替换右坞时仍活着）。不要只挂在 `DockPanel`。
- Renderer 一律 `getBrowser()` / `listen()`，不要直接 `window.gren`。
- `GrenRuntimeBridge` 的 `browser` 声明为**可选**（`browser?: GrenBrowserApi`），`getBrowser()` 用 `bridge().browser ?? previewBrowser` 兜底——写成必填会让 `??` 的左操作数永不为空，TypeScript 7 直接报错，而 `src/platform/runtime.test.ts` 里只 stub 部分字段的写法正需要这层兜底。
- `src/features/chat/input/editor/useTauriFileDrop.test.ts` 用的是真实 preload（`import('../../../../../electron/preload')` 后取 `exposeInMainWorld` 第二个参数），加 `browser` **预计不需要改它**，只当回归跑。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/browser/webviewPolicy.ts` | attach / 主文档白名单；`applyWillAttachPolicy` |
| `electron-agent/electron/browser/webviewPolicy.test.ts` | 白名单与 harden 字段 |
| `electron-agent/electron/browser/webviewGuestRegistry.ts` | tabId ↔ webContentsId 内存表 |
| `electron-agent/electron/browser/webviewGuestRegistry.test.ts` | 类型校验、detach、destroy |
| `electron-agent/electron/browser/webviewPopup.ts` | 开窗判定、修饰键粘滞、`attachGuestWindowOpenHandler` |
| `electron-agent/electron/browser/webviewPopup.test.ts` | disposition / 修饰键 / blur |
| `electron-agent/electron/browser/webviewContextMenu.ts` | 从 `webviewSecurity.ts` 原样挪右键菜单 |
| `electron-agent/electron/browser/attachEmbeddedWebview.ts` | 窗口入口：will-attach / will-navigate / popup / 菜单 / 登记表 / `attachGuestCommand` |
| `electron-agent/electron/browser/attachEmbeddedWebview.test.ts` | 入口装配：拒绝 src、did-attach 挂 handler、registryFor |
| `electron-agent/electron/browser/webviewPreload.ts` | 空 guest preload（无 click 劫持） |
| `electron-agent/electron/main.ts` | `attachEmbeddedWebview` |
| `electron-agent/electron.vite.config.ts` | preload 入口路径 |
| `electron-agent/electron/ipc/register.ts` | `browser_attach_guest` / `browser_detach_guest` |
| `electron-agent/electron/ipc/commandCoverage.test.ts` | 命令名在清单里 |
| `electron-agent/electron/preload.ts` | `gren.browser` |
| `electron-agent/src/platform/runtime.ts` | `GrenBrowserApi`、`getBrowser`、preview 兜底 |
| `electron-agent/src/stores/dockStore.ts` | `BrowserPayload.faviconUrl` |
| `electron-agent/src/features/dock/openLauncherTab.ts` | `about:blank`、新增 `nextBrowserTabId`（`uniqueId` 由 `Date.now()` 改为递增 nonce） |
| `electron-agent/src/features/dock/openLauncherTab.test.ts` | 启动器初始 URL 与 id 唯一性 |
| `electron-agent/src/features/dock/browser/browserUrls.ts` | renderer 侧 URL 白名单（地址栏 + popup 共用，不 import `electron/`） |
| `electron-agent/src/features/dock/browser/browserUrls.test.ts` | 协议白名单用例 |
| `electron-agent/src/features/dock/browser/openBrowserPopupTab.ts` | IPC 载荷 → 同坞新 tab |
| `electron-agent/src/features/dock/browser/openBrowserPopupTab.test.ts` | 同坞 / 右坞、非法 URL、id 不撞 |
| `electron-agent/src/features/dock/browser/useBrowserOpenUrl.ts` | `listen('browser-open-url')` |
| `electron-agent/src/features/dock/browser/useBrowserOpenUrl.test.tsx` | 订阅与卸载 |
| `electron-agent/src/features/dock/DockDndProvider.tsx` | 调用该 hook |
| `electron-agent/src/features/dock/browser/safeWebviewCall.ts` | 吞 attach/disposed 同步抛错 |
| `electron-agent/src/features/dock/browser/safeWebviewCall.test.ts` | 吞 / 抛边界 |
| `electron-agent/src/features/dock/browser/BrowserBody.tsx` | 工具栏 + webview + 事件 |
| `electron-agent/src/features/dock/browser/BrowserBody.test.tsx` | 元素事件、加载失败、崩溃重建 |
| `electron-agent/src/features/dock/TabBodyRenderer.tsx` | 改 import |
| `electron-agent/src/platform/webview.d.ts` | 去掉 `webpreferences`；`allowpopups` 收窄成 `'true' \| 'false'` |
| `electron-agent/src/index.css` | `.gren-browser-failure`：失败覆盖层的按钮要能点（`.gren-browser-status` 是 `pointer-events: none`） |

删除：`electron/webviewSecurity.ts`、`electron/webviewSecurity.test.ts`、`electron/webviewPreload.ts`、`electron/webviewPreload.test.ts`、`src/features/dock/BrowserBody.tsx`、`src/features/dock/BrowserBody.test.tsx`（后两者是挪走不是丢掉实现）。

不修改：`page` tab、`VisualPanel`、工具栏「更多」空按钮、Agent 工具。

---

### 任务 1：webviewPolicy 白名单与 attach 硬化

**文件：**
- 创建：`electron-agent/electron/browser/webviewPolicy.ts`
- 测试：`electron-agent/electron/browser/webviewPolicy.test.ts`
- 删除：`electron-agent/electron/webviewSecurity.test.ts`（白名单迁完后本任务末删除；`webviewSecurity.ts` 留到任务 4 再删，避免 main 暂时断编译）

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/browser/webviewPolicy.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { applyWillAttachPolicy, isAllowedPopupUrl, isAllowedWebviewUrl } from './webviewPolicy';

describe('isAllowedWebviewUrl', () => {
  it('allows http(s) documents and exact about:blank', () => {
    expect(isAllowedWebviewUrl('https://example.com')).toBe(true);
    expect(isAllowedWebviewUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedWebviewUrl('about:blank')).toBe(true);
  });

  it('rejects executable, file, data, and other about URLs', () => {
    expect(isAllowedWebviewUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedWebviewUrl('file:///C:/secret.txt')).toBe(false);
    expect(isAllowedWebviewUrl('data:text/html,hi')).toBe(false);
    expect(isAllowedWebviewUrl('about:srcdoc')).toBe(false);
    expect(isAllowedWebviewUrl('not a url')).toBe(false);
  });
});

describe('isAllowedPopupUrl', () => {
  it('allows only http(s)', () => {
    expect(isAllowedPopupUrl('https://example.com/a')).toBe(true);
    expect(isAllowedPopupUrl('http://127.0.0.1/')).toBe(true);
    expect(isAllowedPopupUrl('about:blank')).toBe(false);
    expect(isAllowedPopupUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('applyWillAttachPolicy', () => {
  it('hardens preferences, strips attacker params, and keeps allowpopups untouched', () => {
    const webPreferences = {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      preload: 'https://evil.test/preload.js',
    };
    const params: Record<string, unknown> = {
      src: 'https://example.com',
      preload: 'https://evil.test/preload.js',
      nodeintegration: 'true',
      disablewebsecurity: 'true',
      allowpopups: true,
    };
    expect(applyWillAttachPolicy(webPreferences, params, '/app/preload/webviewPreload.js')).toBe(true);
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: '/app/preload/webviewPreload.js',
    });
    expect(params.preload).toBeUndefined();
    expect(params.nodeintegration).toBeUndefined();
    expect(params.disablewebsecurity).toBeUndefined();
    expect(params.allowpopups).toBe(true);
  });

  it('rejects disallowed src so the caller can preventDefault', () => {
    const webPreferences = {};
    const params = { src: 'file:///C:/secret.txt' };
    expect(applyWillAttachPolicy(webPreferences as never, params, '/preload.js')).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewPolicy.test.ts
```

预期：FAIL，`Cannot find module './webviewPolicy'`。

- [ ] **步骤 3：编写最少实现**

创建 `electron-agent/electron/browser/webviewPolicy.ts`：

```ts
const DOCUMENT_PROTOCOLS = new Set(['http:', 'https:']);

export function isAllowedWebviewUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === 'about:blank') return true;
  try {
    return DOCUMENT_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

export function isAllowedPopupUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function applyWillAttachPolicy(
  webPreferences: {
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
    preload?: string;
  },
  params: Record<string, unknown>,
  preloadPath: string,
): boolean {
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.preload = preloadPath;
  delete params.preload;
  delete params.nodeintegration;
  delete params.disablewebsecurity;
  const src = typeof params.src === 'string' && params.src.trim() ? params.src : 'about:blank';
  return isAllowedWebviewUrl(src);
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewPolicy.test.ts
```

预期：PASS。然后删除 `electron/webviewSecurity.test.ts`（白名单已迁走；`attachWebviewSecurity` 仍被 main 引用直到任务 4）。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/electron/browser/webviewPolicy.ts electron-agent/electron/browser/webviewPolicy.test.ts electron-agent/electron/webviewSecurity.test.ts
git commit -m @"
feat(browser): add webview URL policy without about-scheme blanket allow

"@
```

---

### 任务 2：webviewGuestRegistry

**文件：**
- 创建：`electron-agent/electron/browser/webviewGuestRegistry.ts`
- 测试：`electron-agent/electron/browser/webviewGuestRegistry.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { WebviewGuestRegistry } from './webviewGuestRegistry';

function guest(partial: { id: number; type?: string; destroyed?: boolean }) {
  return {
    id: partial.id,
    getType: () => partial.type ?? 'webview',
    isDestroyed: () => partial.destroyed === true,
    once: vi.fn(),
  };
}

describe('WebviewGuestRegistry', () => {
  it('maps a live webview guest to a tab id', () => {
    const registry = new WebviewGuestRegistry();
    expect(registry.attach('tab-1', guest({ id: 42 }))).toEqual({ ok: true });
    expect(registry.tabIdFor(42)).toBe('tab-1');
  });

  it('rejects non-webview and destroyed guests', () => {
    const registry = new WebviewGuestRegistry();
    expect(registry.attach('tab-1', guest({ id: 1, type: 'window' }))).toEqual({ ok: false });
    expect(registry.attach('tab-1', guest({ id: 2, destroyed: true }))).toEqual({ ok: false });
    expect(registry.tabIdFor(1)).toBeUndefined();
  });

  it('clears on detach and on destroyed', () => {
    const registry = new WebviewGuestRegistry();
    const view = guest({ id: 7 });
    registry.attach('tab-7', view);
    registry.detach('tab-7');
    expect(registry.tabIdFor(7)).toBeUndefined();

    registry.attach('tab-8', view);
    // 同一 guest 二次 attach 会在 mock 上再注册一个 destroyed 回调，必须取最近注册的那个。
    const destroyed = view.once.mock.calls.at(-1)?.[1] as (() => void) | undefined;
    expect(destroyed).toBeTypeOf('function');
    destroyed?.();
    expect(registry.tabIdFor(7)).toBeUndefined();
  });
});
```

注意：第二次 attach 复用 `view.id === 7`，于是同一个 mock 上挂了两个 destroyed 回调——**必须取最后一次注册的**（`.at(-1)`）。若用 `find` 取到第一次那个，其闭包里的 tabId 是 `'tab-7'`，守卫不成立、什么都不会删，断言会失败。实现侧保持「注册时记下 tabId + 触发时校验当前映射」的写法，不要改成按 `guest.id` 反查——那会让上一次登记的旧回调误删新登记的条目。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewGuestRegistry.test.ts
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现**

```ts
export interface GuestLike {
  id: number;
  getType(): string;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
}

export class WebviewGuestRegistry {
  private readonly tabByContents = new Map<number, string>();
  private readonly contentsByTab = new Map<string, number>();

  attach(tabId: string, guest: GuestLike): { ok: boolean } {
    if (guest.isDestroyed() || guest.getType() !== 'webview') return { ok: false };
    this.detach(tabId);
    const previousTab = this.tabByContents.get(guest.id);
    if (previousTab) this.contentsByTab.delete(previousTab);
    this.tabByContents.set(guest.id, tabId);
    this.contentsByTab.set(tabId, guest.id);
    guest.once('destroyed', () => {
      if (this.tabByContents.get(guest.id) === tabId) this.detach(tabId);
    });
    return { ok: true };
  }

  detach(tabId: string): void {
    const contentsId = this.contentsByTab.get(tabId);
    this.contentsByTab.delete(tabId);
    if (contentsId !== undefined && this.tabByContents.get(contentsId) === tabId) {
      this.tabByContents.delete(contentsId);
    }
  }

  tabIdFor(webContentsId: number): string | undefined {
    return this.tabByContents.get(webContentsId);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewGuestRegistry.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/electron/browser/webviewGuestRegistry.ts electron-agent/electron/browser/webviewGuestRegistry.test.ts
git commit -m @"
feat(browser): track webview guests by tab id in memory

"@
```

---

### 任务 3：webviewPopup 判定与修饰键粘滞

**文件：**
- 创建：`electron-agent/electron/browser/webviewPopup.ts`
- 测试：`electron-agent/electron/browser/webviewPopup.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { attachGuestWindowOpenHandler, decideWindowOpen, shouldClearModifierOnKeyUp } from './webviewPopup';

describe('decideWindowOpen', () => {
  it('drops non-http(s) URLs', () => {
    expect(decideWindowOpen({ url: 'about:blank', disposition: 'new-window', modifierActive: false })).toEqual({
      kind: 'drop',
    });
  });

  it('opens background-tab and modifier clicks externally', () => {
    expect(
      decideWindowOpen({ url: 'https://a.test', disposition: 'background-tab', modifierActive: false }),
    ).toEqual({ kind: 'external', url: 'https://a.test' });
    expect(
      decideWindowOpen({ url: 'https://a.test', disposition: 'new-window', modifierActive: true }),
    ).toEqual({ kind: 'external', url: 'https://a.test' });
  });

  it('routes ordinary popups internally', () => {
    expect(
      decideWindowOpen({ url: 'https://a.test/x', disposition: 'foreground-tab', modifierActive: false }),
    ).toEqual({ kind: 'internal', url: 'https://a.test/x' });
  });
});

describe('shouldClearModifierOnKeyUp', () => {
  it('clears only when the released key is Control or Meta', () => {
    expect(shouldClearModifierOnKeyUp({ type: 'keyUp', key: 'Control', code: 'ControlLeft' })).toBe(true);
    expect(shouldClearModifierOnKeyUp({ type: 'keyUp', key: 'Meta', code: 'MetaLeft' })).toBe(true);
    expect(shouldClearModifierOnKeyUp({ type: 'keyUp', key: 'a', code: 'KeyA', control: true })).toBe(false);
    expect(shouldClearModifierOnKeyUp({ type: 'keyDown', key: 'Control', code: 'ControlLeft' })).toBe(false);
  });
});

interface SimGuest {
  listeners: Record<string, Array<(...args: never[]) => void>>;
  id: number;
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
}

function makeGuest(): SimGuest {
  const listeners: SimGuest['listeners'] = {};
  return {
    id: 9,
    listeners,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    setWindowOpenHandler: vi.fn(),
  };
}

describe('attachGuestWindowOpenHandler', () => {
  it('always denies native windows and follows decideWindowOpen', () => {
    const guest = makeGuest();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: (id) => (id === 9 ? 'tab-9' : undefined),
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });

    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };
    expect(handler({ url: 'https://a.test', disposition: 'new-window' })).toEqual({ action: 'deny' });
    expect(sendInternal).toHaveBeenCalledWith('gren:event:browser-open-url', {
      url: 'https://a.test',
      disposition: 'new-window',
      sourceTabId: 'tab-9',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens externally after Control keyDown and stops after Control keyUp', () => {
    const guest = makeGuest();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: () => 'tab-9',
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });
    const onInput = guest.listeners['before-input-event']?.[0];
    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };

    onInput?.({} as never, { type: 'keyDown', key: 'Control', code: 'ControlLeft', control: true } as never);
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).toHaveBeenCalledWith('https://a.test');
    expect(sendInternal).not.toHaveBeenCalled();

    sendInternal.mockClear();
    openExternal.mockClear();
    onInput?.({} as never, { type: 'keyUp', key: 'Control', code: 'ControlLeft', control: true } as never);
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(sendInternal).toHaveBeenCalled();
  });

  it('clears sticky modifier on guest blur', () => {
    const guest = makeGuest();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: () => 'tab-9',
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });
    const onInput = guest.listeners['before-input-event']?.[0];
    const onBlur = guest.listeners.blur?.[0];
    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };
    onInput?.({} as never, { type: 'keyDown', key: 'Meta', code: 'MetaLeft', meta: true } as never);
    onBlur?.();
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(sendInternal).toHaveBeenCalled();
  });
});
```

`embedder` 的 `blur` 也要清粘滞（`embedder.on('blur', clear)`；`WebContents` 有该事件，语义是「WebContents 失去焦点」）。上面三例的 embedder 是简化对象，没有 listeners 表，所以补一条独立用例：

```ts
function makeEmbedder() {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  return {
    listeners,
    send: vi.fn(),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
  };
}

it('clears sticky modifier when the host webContents blurs', () => {
  const guest = makeGuest();
  const embedder = makeEmbedder();
  const openExternal = vi.fn(async () => {});
  const sendInternal = vi.fn();
  attachGuestWindowOpenHandler({
    guest: guest as never,
    embedder: embedder as never,
    tabIdFor: () => 'tab-9',
    eventChannel: 'gren:event:browser-open-url',
    openExternal,
    sendInternal,
    warn: vi.fn(),
  });

  guest.listeners['before-input-event']?.[0]?.(
    {} as never,
    { type: 'keyDown', key: 'Control', code: 'ControlLeft', control: true } as never,
  );
  embedder.listeners.blur?.[0]?.();

  const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
    url: string;
    disposition: string;
  }) => { action: string };
  handler({ url: 'https://a.test', disposition: 'new-window' });
  expect(openExternal).not.toHaveBeenCalled();
  expect(sendInternal).toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewPopup.test.ts
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现**

`webviewPopup.ts` 必须包含：

- `decideWindowOpen` / `shouldClearModifierOnKeyUp`
- `isModifierDown(input)`：`control`/`meta` 为 true，或 `modifiers` 含 `control`/`ctrl`/`meta`/`command`/`cmd`
- `attachGuestWindowOpenHandler`：
  - `setWindowOpenHandler` 先 `deny`
  - `before-input-event`：keyUp 且 `shouldClearModifierOnKeyUp` → `modifierActive=false`；否则 `modifierActive = isModifierDown(input)`
  - `guest.on('blur')` 与 `embedder.on('blur')` 清 `modifierActive`
  - `drop`：`warn` 日志
  - `external`：`openExternal(url).catch(warn)`
  - `internal`：`sendInternal(eventChannel, { url, disposition, sourceTabId })`，`sourceTabId` 仅在 `tabIdFor(guest.id)` 有值时带上
  - disposition 原样传入（测试用 `'new-window'`）

`openExternal` 失败只 `warn`，不要 throw。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewPopup.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/electron/browser/webviewPopup.ts electron-agent/electron/browser/webviewPopup.test.ts
git commit -m @"
feat(browser): route webview popups without leaving a sticky modifier

"@
```

---

### 任务 4：attachEmbeddedWebview 入口并替换 main

**文件：**
- 创建：`electron-agent/electron/browser/webviewContextMenu.ts`（从 `webviewSecurity.ts` 的 `showWebviewContextMenu` 原样搬；`isAllowedWebviewUrl` 改从 `./webviewPolicy` import）
- 创建：`electron-agent/electron/browser/attachEmbeddedWebview.ts`
- 测试：`electron-agent/electron/browser/attachEmbeddedWebview.test.ts`
- 修改：`electron-agent/electron/main.ts`（`attachWebviewSecurity` → `attachEmbeddedWebview`）
- 删除：`electron-agent/electron/webviewSecurity.ts`

- [ ] **步骤 1：编写失败的测试**

`attachEmbeddedWebview.test.ts` 用 `devtoolsShortcut.test.ts` 同款 `makeTarget`：

```ts
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  BrowserWindow: { fromWebContents: vi.fn(() => ({ isDestroyed: () => false })) },
  clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  shell: { openExternal: vi.fn() },
  // 任务 6 的 attachGuestCommand 会用它；本任务只需要它存在，避免 undefined。
  webContents: { fromId: vi.fn() },
}));
vi.mock('electron', () => electron);

import { attachEmbeddedWebview, registryFor } from './attachEmbeddedWebview';
import { IPC_CHANNELS } from '../ipc/contracts';

function makeEmbedder() {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  return {
    listeners,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    send: vi.fn(),
  };
}

describe('attachEmbeddedWebview', () => {
  it('prevents attaching a file URL and allows https', () => {
    const embedder = makeEmbedder();
    attachEmbeddedWebview(embedder as never);
    const willAttach = embedder.listeners['will-attach-webview']?.[0];
    const preventDefault = vi.fn();
    const prefs: Record<string, unknown> = {};
    willAttach?.({ preventDefault } as never, prefs as never, { src: 'file:///C:/x' } as never);
    expect(preventDefault).toHaveBeenCalled();
    preventDefault.mockClear();
    willAttach?.({ preventDefault } as never, prefs as never, { src: 'https://example.com' } as never);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({ nodeIntegration: false, sandbox: true });
  });

  it('stores a registry on the embedder', () => {
    const embedder = makeEmbedder();
    attachEmbeddedWebview(embedder as never);
    expect(registryFor(embedder as never)).toBeTruthy();
  });
});
```

再测 `did-attach-webview`：假 guest 有 `on` / `setWindowOpenHandler` / `id`；断言 `setWindowOpenHandler` 被调用；guest `will-navigate` 到 `javascript:` 时 `preventDefault`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/attachEmbeddedWebview.test.ts
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现**

`attachEmbeddedWebview.ts`：

```ts
const registries = new WeakMap<WebContents, WebviewGuestRegistry>();

export function registryFor(embedder: WebContents): WebviewGuestRegistry | undefined {
  return registries.get(embedder);
}

export function attachEmbeddedWebview(embedder: WebContents): void {
  const registry = new WebviewGuestRegistry();
  registries.set(embedder, registry);
  const preloadPath = join(__dirname, '../preload/webviewPreload.js');

  embedder.on('will-attach-webview', (event, webPreferences, params) => {
    const allowed = applyWillAttachPolicy(webPreferences, params as unknown as Record<string, unknown>, preloadPath);
    if (!allowed) event.preventDefault();
  });

  embedder.on('did-attach-webview', (_event, guest) => {
    guest.on('will-navigate', (event, url) => {
      if (!isAllowedWebviewUrl(url)) event.preventDefault();
    });
    attachGuestWindowOpenHandler({
      guest,
      embedder,
      tabIdFor: (id) => registry.tabIdFor(id),
      eventChannel: `${IPC_CHANNELS.eventPrefix}browser-open-url`,
      openExternal: (url) => shell.openExternal(url),
      sendInternal: (channel, payload) => embedder.send(channel, payload),
      warn: (message) => console.warn(message),
    });
    guest.on('context-menu', (_event, params) => {
      const hostWindow = BrowserWindow.fromWebContents(embedder);
      if (!hostWindow || hostWindow.isDestroyed()) return;
      showWebviewContextMenu(guest, params, hostWindow);
    });
  });
}
```

`will-navigate` 没有 `isMainFrame` 时按主文档拦（Electron 的 `will-navigate` 就是主 frame）。

`main.ts`：`import { attachEmbeddedWebview } from "./browser/attachEmbeddedWebview";` 并替换 `attachWebviewSecurity(window.webContents)`。删除 `webviewSecurity.ts`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser/webviewPolicy.test.ts electron/browser/webviewPopup.test.ts electron/browser/webviewGuestRegistry.test.ts electron/browser/attachEmbeddedWebview.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/electron/browser/webviewContextMenu.ts electron-agent/electron/browser/attachEmbeddedWebview.ts electron-agent/electron/browser/attachEmbeddedWebview.test.ts electron-agent/electron/main.ts electron-agent/electron/webviewSecurity.ts
git commit -m @"
feat(browser): attach hardened webviews from electron/browser

"@
```

---

### 任务 5：空 preload 与 Vite 入口

**文件：**
- 创建：`electron-agent/electron/browser/webviewPreload.ts`（空模块：`export {}`；只为保住 `out/preload/webviewPreload.js` 这个产物路径、以及后续要挂 preload 时的位置，本期不注入任何行为）
- 修改：`electron-agent/electron.vite.config.ts` 第 55 行入口改为 `electron/browser/webviewPreload.ts`
- 删除：`electron-agent/electron/webviewPreload.ts`、`electron-agent/electron/webviewPreload.test.ts`

- [ ] **步骤 1：确认旧劫持测试会随文件删除**

不要改写 `findAnchor` 测试去迁就新行为。直接删 `webviewPreload.test.ts`。

- [ ] **步骤 2：换入口并放空 preload**

`electron.vite.config.ts`：

```ts
webviewPreload: resolve(__dirname, "electron/browser/webviewPreload.ts"),
```

产物文件名仍是 `webviewPreload.js`（`entryFileNames: "[name].js"`），`attachEmbeddedWebview` 的 `../preload/webviewPreload.js` 不用改。

- [ ] **步骤 3：运行仍相关的测试**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/browser
```

预期：PASS。（`electron/webviewPreload.test.ts` 已在本任务删除，不要再把它写进任何命令。）

- [ ] **步骤 4：Commit**（仅用户要求时）

```powershell
git add electron-agent/electron/browser/webviewPreload.ts electron-agent/electron.vite.config.ts electron-agent/electron/webviewPreload.ts electron-agent/electron/webviewPreload.test.ts
git commit -m @"
feat(browser): drop guest click hijack from webview preload

"@
```

---

### 任务 6：IPC 与 runtime 桥

**文件：**
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/electron/ipc/commandCoverage.test.ts`（`expectedCommands` 加上 `'browser_attach_guest', 'browser_detach_guest'`）
- 修改：`electron-agent/electron/preload.ts`
- 修改：`electron-agent/electron/browser/attachEmbeddedWebview.ts`（加 `attachGuestCommand` / `detachGuestCommand`）
- 修改：`electron-agent/src/platform/runtime.ts`
- 修改：`electron-agent/src/platform/runtime.test.ts`
- 测试：`electron-agent/electron/ipc/register.test.ts` 追加 attach/detach 用例（`vi.hoisted` mock 补 `webContents`）

- [ ] **步骤 1：编写失败的测试**

本任务只测 IPC **把参数转给 registry**，不碰真实 `webContents`。

先在 `register.test.ts` 顶部的 `vi.hoisted` mock 里补上（当前它没有这个键，缺了会 TypeError）：

```ts
webContents: { fromId: vi.fn() },
```

在 `attachEmbeddedWebview.ts` 增加（`webContents` 从 `electron` import）：

```ts
export function attachGuestCommand(embedder: WebContents, tabId: string, webContentsId: number): { ok: boolean }
export function detachGuestCommand(embedder: WebContents, tabId: string): { ok: boolean }
```

`attachGuestCommand`：`const guest = webContents.fromId(webContentsId)`；没有则 `{ ok: false }`；有则 `registryFor(embedder)?.attach(tabId, guest) ?? { ok: false }`。`detachGuestCommand` 恒返回 `{ ok: true }`（表里没有该 tab 就删空表，不要抛错）。

`register.test.ts` 末尾追加（完整可运行）：

```ts
it('registers browser guest attach and detach commands', async () => {
  const { attachEmbeddedWebview, attachGuestCommand, detachGuestCommand, registryFor } = await import(
    '../browser/attachEmbeddedWebview'
  );
  registerIpcHandlers();
  const invoke = handler(IPC_CHANNELS.invoke);

  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  const embedder = {
    listeners,
    on: vi.fn((event: string, fn: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(fn);
    }),
    send: vi.fn(),
  };
  attachEmbeddedWebview(embedder as never);

  const guest = { id: 42, getType: () => 'webview', isDestroyed: () => false, once: vi.fn() };
  electron.webContents.fromId.mockReturnValue(guest);

  await expect(
    invoke({ sender: embedder }, { command: 'browser_attach_guest', args: { tabId: 'tab-1', webContentsId: 42 } }),
  ).resolves.toEqual({ ok: true });
  expect(registryFor(embedder as never)?.tabIdFor(42)).toBe('tab-1');

  await expect(
    invoke({ sender: embedder }, { command: 'browser_detach_guest', args: { tabId: 'tab-1' } }),
  ).resolves.toEqual({ ok: true });
  expect(registryFor(embedder as never)?.tabIdFor(42)).toBeUndefined();

  // 坏参数不能被静默吞掉：fallback 传 0 会被 readPositiveInteger 拒掉。
  await expect(
    invoke({ sender: embedder }, { command: 'browser_attach_guest', args: { tabId: 'tab-2', webContentsId: 0 } }),
  ).rejects.toThrow();

  // 找不到 guest：不抛，返回 ok:false。
  electron.webContents.fromId.mockReturnValue(undefined);
  expect(attachGuestCommand(embedder as never, 'tab-3', 999)).toEqual({ ok: false });
  expect(detachGuestCommand(embedder as never, 'tab-3')).toEqual({ ok: true });
});
```

`runtime.test.ts` 增加：

```ts
it('exposes getBrowser attachGuest', async () => {
  const attachGuest = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('window', {
    gren: {
      invoke: async () => ({ ok: true }),
      subscribe: async () => () => {},
      pickDirectory: async () => null,
      openUrl: async () => {},
      openPath: async () => {},
      revealItemInDir: async () => {},
      window: {},
      webview: {},
      browser: { attachGuest, detachGuest: async () => {} },
    },
  });
  const { getBrowser } = await import('./runtime');
  await expect(getBrowser().attachGuest({ tabId: 't', webContentsId: 1 })).resolves.toEqual({ ok: true });
});
```

现有 runtime 测试里手写的 `gren` 对象要补 `browser: { attachGuest: async () => ({ ok: false }), detachGuest: async () => {} }`，否则若你把字段做成必填会红。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/platform/runtime.test.ts electron/ipc/commandCoverage.test.ts
```

预期：FAIL（没有 `getBrowser` / 命令不在清单）。

- [ ] **步骤 3：编写最少实现**

`register.ts` 在 `registerIpcHandlers` 里（不依赖其它 services）：

```ts
registerCommand('browser_attach_guest', (event, args) =>
  attachGuestCommand(event.sender, readString(args, 'tabId'), readPositiveInteger(args, 'webContentsId', 0)),
);
registerCommand('browser_detach_guest', (event, args) =>
  detachGuestCommand(event.sender, readString(args, 'tabId')),
);
```

`readPositiveInteger(..., 0)`：缺省 0 会因 `< 1` 抛错。不要静默 `{ ok: false }` 掩盖坏参数。

`preload.ts` 的 `exposeInMainWorld` 增加：

```ts
browser: {
  attachGuest: (input: { tabId: string; webContentsId: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.invoke, { command: 'browser_attach_guest', args: input }),
  detachGuest: (input: { tabId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.invoke, { command: 'browser_detach_guest', args: input }),
},
```

`runtime.ts`：

```ts
export interface GrenBrowserApi {
  attachGuest(input: { tabId: string; webContentsId: number }): Promise<{ ok: boolean }>;
  /** 与 attachGuest 同源；主进程恒返回 { ok: true }。 */
  detachGuest(input: { tabId: string }): Promise<{ ok: boolean }>;
}

export interface GrenRuntimeBridge {
  // 现有字段...
  /** 可选：老 preload（热更新窗口期）可能还没有这一面。 */
  browser?: GrenBrowserApi;
}

const previewBrowser: GrenBrowserApi = {
  attachGuest: async () => ({ ok: false }),
  detachGuest: async () => ({ ok: false }),
};

// browserPreviewBridge.browser = previewBrowser

export function getBrowser(): GrenBrowserApi {
  return bridge().browser ?? previewBrowser;
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/platform/runtime.test.ts electron/ipc/commandCoverage.test.ts electron/ipc/register.test.ts src/features/chat/input/editor/useTauriFileDrop.test.ts
```

预期：PASS。`useTauriFileDrop.test.ts` 走真实 preload（`exposeInMainWorld` 的第二个参数直接赋给 `window.gren`），加 `browser` 不会让它变红，属回归跑；它若红了说明 preload 的桥面被改坏了。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/register.test.ts electron-agent/electron/ipc/commandCoverage.test.ts electron-agent/electron/preload.ts electron-agent/electron/browser/attachEmbeddedWebview.ts electron-agent/src/platform/runtime.ts electron-agent/src/platform/runtime.test.ts
git commit -m @"
feat(browser): register guest attach commands on the runtime bridge

"@
```

---

### 任务 7：启动器 about:blank、popup 开 tab、订阅事件

**文件：**
- 修改：`electron-agent/src/stores/dockStore.ts`（`BrowserPayload` 加可选 `faviconUrl?: string`）
- 修改：`electron-agent/src/features/dock/openLauncherTab.ts`
- 修改：`electron-agent/src/features/dock/openLauncherTab.test.ts`
- 创建：`electron-agent/src/features/dock/browser/browserUrls.ts`
- 测试：`electron-agent/src/features/dock/browser/browserUrls.test.ts`
- 创建：`electron-agent/src/features/dock/browser/openBrowserPopupTab.ts`
- 测试：`electron-agent/src/features/dock/browser/openBrowserPopupTab.test.ts`
- 创建：`electron-agent/src/features/dock/browser/useBrowserOpenUrl.ts`
- 测试：`electron-agent/src/features/dock/browser/useBrowserOpenUrl.test.tsx`
- 修改：`electron-agent/src/features/dock/DockDndProvider.tsx`（调用 hook）

- [ ] **步骤 1：编写失败的测试**

`openLauncherTab.test.ts` 现有「opens browser and terminal」用例追加：

```ts
expect(tabs.filter((t) => t.kind === 'browser').every((t) => (t.payload as { url: string }).url === 'about:blank')).toBe(true);
expect(new Set(tabs.filter((t) => t.kind === 'browser').map((t) => t.id)).size).toBe(2);
```

`openBrowserPopupTab.test.ts`：

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore } from '../../../stores/dockStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { openBrowserPopupTab } from './openBrowserPopupTab';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('openBrowserPopupTab', () => {
  beforeEach(reset);

  it('opens beside the source tab and activates it', () => {
    useDockStore.getState().addTab({
      id: 'src',
      kind: 'browser',
      region: 'bottom',
      title: '源',
      closable: true,
      payload: { url: 'https://a.test' },
    });
    openBrowserPopupTab({ url: 'https://b.test', disposition: 'new-window', sourceTabId: 'src' });
    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'browser');
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => t.region === 'bottom')).toBe(true);
    expect(useDockStore.getState().activeByRegion.bottom).not.toBe('src');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    expect(tabs.some((t) => (t.payload as { url: string }).url === 'https://b.test')).toBe(true);
  });

  it('falls back to the right dock without a source', () => {
    openBrowserPopupTab({ url: 'https://c.test', disposition: 'default' });
    expect(useDockStore.getState().tabs[0]).toMatchObject({ region: 'right', payload: { url: 'https://c.test' } });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('drops non-http(s) payloads', () => {
    openBrowserPopupTab({ url: 'about:blank', disposition: 'default' });
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });

  it('does not collide ids for two popups in the same turn', () => {
    openBrowserPopupTab({ url: 'https://a.test', disposition: 'default' });
    openBrowserPopupTab({ url: 'https://b.test', disposition: 'default' });
    const ids = useDockStore.getState().tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});
```

`useBrowserOpenUrl.test.tsx`：mock `listen`，renderHook，推一条 payload，断言 `openBrowserPopupTab` 效果（或 spy `openBrowserPopupTab`）。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/openLauncherTab.test.ts src/features/dock/browser/openBrowserPopupTab.test.ts
```

预期：FAIL（仍是 example.com / 模块不存在）。

- [ ] **步骤 3：编写最少实现**

`openLauncherTab.ts`：只改 `uniqueId` 的唯一性来源（`Date.now()` → 模块内递增 nonce，同毫秒不再撞），并新增 `nextBrowserTabId`。`uniqueId` 与 `revealRegion` **保持文件私有**——`addTab` 内部已经 `revealRegion(input.region)`，popup 不需要再导出一份。

```ts
let tabNonce = 0;

function uniqueId(canonical: string): string {
  const tabs = useDockStore.getState().tabs;
  if (!tabs.some((t) => t.id === canonical)) return canonical;
  tabNonce += 1;
  return uniqueId(`${canonical}#${tabNonce}`);
}

export function nextBrowserTabId(): string {
  tabNonce += 1;
  return uniqueId(`browser:${tabNonce}`);
}
```

浏览器启动器分支：`id: nextBrowserTabId()`，`payload: { url: 'about:blank', title: '浏览器' }`。

`src/features/dock/browser/browserUrls.ts`（renderer 侧白名单，地址栏与 popup 共用。**不要**从 renderer import `electron-agent/electron/**`，主进程代码会被打进 renderer 产物）：

```ts
const DOCUMENT_PROTOCOLS = new Set(['http:', 'https:']);

/** 地址栏：http(s)，或精确 about:blank。 */
export function isAllowedDocumentUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === 'about:blank') return true;
  try {
    return DOCUMENT_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/** popup 载荷：仅 http(s)。 */
export function isAllowedPopupUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
```

`openBrowserPopupTab`：非法 URL return；否则 `region = useDockStore.getState().tabs.find((t) => t.id === payload.sourceTabId)?.region ?? 'right'`；`addTab({ id: nextBrowserTabId(), kind: 'browser', region, title: '浏览器', closable: true, payload: { url, title: '浏览器' } })`。**不要再调 `revealRegion`**——`addTab` 已经设好该 region 的 active 并展开面板。

`useBrowserOpenUrl.ts`：

```ts
export function useBrowserOpenUrl(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<BrowserOpenUrlPayload>('browser-open-url', (event) => {
      openBrowserPopupTab(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
```

对齐 `TerminalBody` 对异步 `listen` 的 disposed 处理。

`DockDndProvider` 顶部调用 `useBrowserOpenUrl()`（与 `useDockLauncherHotkeys` 并列）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/openLauncherTab.test.ts src/features/dock/browser/openBrowserPopupTab.test.ts src/features/dock/browser/useBrowserOpenUrl.test.tsx src/features/dock/DockPanel.test.tsx src/features/dock/useDockLauncherHotkeys.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/src/stores/dockStore.ts electron-agent/src/features/dock/openLauncherTab.ts electron-agent/src/features/dock/openLauncherTab.test.ts electron-agent/src/features/dock/DockDndProvider.tsx electron-agent/src/features/dock/browser/browserUrls.ts electron-agent/src/features/dock/browser/browserUrls.test.ts electron-agent/src/features/dock/browser/openBrowserPopupTab.ts electron-agent/src/features/dock/browser/openBrowserPopupTab.test.ts electron-agent/src/features/dock/browser/useBrowserOpenUrl.ts electron-agent/src/features/dock/browser/useBrowserOpenUrl.test.tsx
git commit -m @"
feat(browser): open popup tabs beside the source dock region

"@
```

---

### 任务 8：搬 BrowserBody 并对齐元素事件

**文件：**
- 创建：`electron-agent/src/features/dock/browser/safeWebviewCall.ts`
- 测试：`electron-agent/src/features/dock/browser/safeWebviewCall.test.ts`
- 创建：`electron-agent/src/features/dock/browser/BrowserBody.tsx`（从旧文件搬并改）
- 创建：`electron-agent/src/features/dock/browser/BrowserBody.test.tsx`
- 修改：`electron-agent/src/features/dock/TabBodyRenderer.tsx` import `./browser/BrowserBody`
- 删除：`electron-agent/src/features/dock/BrowserBody.tsx`、`BrowserBody.test.tsx`
- 修改：`electron-agent/src/platform/webview.d.ts`：去掉 `webpreferences`，并把 `allowpopups` 收窄成 `'true' | 'false'`（删掉 `boolean`）

- [ ] **步骤 1：编写失败的测试**

`safeWebviewCall.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { safeWebviewCall } from './safeWebviewCall';

describe('safeWebviewCall', () => {
  it('returns fallback for detached guests and rethrows other errors', () => {
    expect(safeWebviewCall(() => { throw new Error('must be attached to the DOM'); }, 'x')).toBe('x');
    expect(safeWebviewCall(() => { throw new Error('Render frame was disposed'); }, 0)).toBe(0);
    expect(() => safeWebviewCall(() => { throw new Error('boom'); }, 0)).toThrow('boom');
    const onDetached = vi.fn();
    safeWebviewCall(() => { throw new Error('must be attached to the DOM'); }, 1, onDetached);
    expect(onDetached).toHaveBeenCalled();
  });
});
```

`BrowserBody.test.tsx`（mock `../../../stores/dockStore` 与 `../../../platform/runtime` 的 `getBrowser`）：

- `allowpopups` 必须是**字符串**属性：`expect(view.getAttribute('allowpopups')).toBe('true')`；**没有** `webpreferences`。
- 地址栏 `example.org` submit → `loadURL('https://example.org')`。
- 派发 `new-window` **不得** `loadURL`。
- `did-fail-load` 子 frame 或 `errorCode === -3` 不出现错误文案。
- 主 frame 失败出现错误文案。
- `did-attach` 调用 `getBrowser().attachGuest`，参数含 `tabId` 与 `getWebContentsId()`。
- payload URL 变了不改 `<webview src>`（仍为首挂 URL）。
- 无 `gren:webview-open` 处理。

假 webview 的公共骨架（**本文件后续所有用例共用，不要在 render 之后 `Object.assign` 单个节点**）：

jsdom 不认识 `<webview>`，React 建出来的就是普通 `HTMLElement`，没有 `getWebContentsId` / `getURL` / `loadURL`。旧测试是 render 完拿 `document.querySelector('webview')` 再赋值，任务 9 的崩溃重建用例不能用这种写法——换 `key` 之后新节点的 effect 在 `fireEvent` 返回之前就跑完了，事后补方法来不及。改为钩住 `document.createElement`：

```ts
let nextWebContentsId = 11;
let currentUrl = 'https://example.com/';
const originalCreateElement = document.createElement.bind(document);

function installFakeWebview(element: HTMLElement) {
  return Object.assign(element, {
    getWebContentsId: () => nextWebContentsId,
    getURL: () => currentUrl,
    canGoBack: () => false,
    canGoForward: () => false,
    loadURL: vi.fn(() => Promise.resolve()),
  });
}

beforeEach(() => {
  nextWebContentsId = 11;
  currentUrl = 'https://example.com/';
  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement(tagName, options);
    return tagName === 'webview' ? installFakeWebview(element) : element;
  }) as typeof document.createElement;
});
afterEach(() => {
  document.createElement = originalCreateElement;
});
```

React 的 DOM host config 创建未知标签时走 `ownerDocument.createElement(type)`，所以这个钩子对 React 建的每个 `<webview>` 都生效，包括换 `key` 之后的新节点。元素身上的 `loadURL` 已经是 mock，断言导航直接读 `view.loadURL`（`vi.mocked(view.loadURL)`）。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/browser/BrowserBody.test.tsx src/features/dock/browser/safeWebviewCall.test.ts
```

预期：FAIL。

- [ ] **步骤 3：编写最少实现**

`BrowserBody` 要点（不要恢复 click 劫持）：

- `webviewGeneration` state，默认 0；`<webview key={\`webview:${webviewGeneration}\`}>`。
- effect 依赖 `[tab.id, webviewGeneration, updateTab]`。
- `did-attach`：`getBrowser().attachGuest({ tabId: tab.id, webContentsId: view.getWebContentsId() })`。effect 末尾再补一次（接线晚于 attach 时兜底），但必须包在 `safeWebviewCall` 里——未 attach 时 `getWebContentsId()` 会抛，取不到就跳过，不要登记非法 id。
- cleanup：`getBrowser().detachGuest({ tabId: tab.id })`。
- 同步 chrome 全部走 `safeWebviewCall`。
- `page-favicon-updated` 在 **ref 回调**里绑定，写入 `payload.faviconUrl`。
- `src={initialUrlRef.current}`；`allowpopups="true"`（**字符串**，写 `{true}` 会被 React 删掉，见硬约束）；`partition="persist:gren-browser"`。
- `src/platform/webview.d.ts` 里 `allowpopups` 只留 `'true' | 'false'`：把「必须写字符串」从注释纪律变成编译错误，写 `{true}` 直接不过 tsc。
- 卸载 `new-window` / `ipc-message`。
- 地址栏：trim 空 → `about:blank`；已有非法协议（`javascript:` 等）不 `loadURL`。复用 `browserUrls.ts` 的 document 白名单；无协议补 `https://`。
- 「更多」空按钮保留。

`TabBodyRenderer`：`import { BrowserBody } from './browser/BrowserBody';`

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock
```

预期：PASS。（`TabBodyRenderer.tsx` 不是测试文件，不要往命令里塞。）

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/src/features/dock/browser/safeWebviewCall.ts electron-agent/src/features/dock/browser/safeWebviewCall.test.ts electron-agent/src/features/dock/browser/BrowserBody.tsx electron-agent/src/features/dock/browser/BrowserBody.test.tsx electron-agent/src/features/dock/TabBodyRenderer.tsx electron-agent/src/features/dock/BrowserBody.tsx electron-agent/src/features/dock/BrowserBody.test.tsx electron-agent/src/platform/webview.d.ts
git commit -m @"
feat(browser): drive dock webview chrome from guest events

"@
```

---

### 任务 9：加载失败、崩溃重建、接线随 generation 复位

**文件：**
- 修改：`electron-agent/src/features/dock/browser/BrowserBody.tsx`
- 修改：`electron-agent/src/features/dock/browser/BrowserBody.test.tsx`
- 修改：`electron-agent/src/index.css`（新增 `.gren-browser-failure`）

- [ ] **步骤 1：编写失败的测试**

在 `BrowserBody.test.tsx` 追加（假 webview 骨架沿用任务 8 的 `document.createElement` 钩子）：

1. 加载失败与重试：主 frame `did-fail-load`（`errorCode: -202`、`errorDescription: 'ERR_CERT_AUTHORITY_INVALID'`、`validatedURL: 'https://bad.test/'`、`isMainFrame: true`）后，「重试」按钮可见、文案含「证书不被信任」；点「重试」调用 `view.loadURL('https://bad.test/')`，且 `document.querySelectorAll('webview')` 仍只有 1 个。
2. 失败后重新发起加载：再派发 `did-start-loading`，「重试」按钮与错误文案一起消失（`loadError` 现在带着 URL，清空规则要重新确认一遍）。
3. 可恢复崩溃：先 `did-navigate`（`currentUrl = 'https://live.test/'`）让 URL 同步成功，再派发 `render-process-gone` `{ reason: 'crashed', exitCode: 1 }`：`detachGuest` 被调用；`document.querySelectorAll('webview')` 仍只有 1 个，但**不是**同一个 element（`expect(rebuilt).not.toBe(view)`）；新节点 `src` 为 `https://live.test/`。
4. 重建后重新登记：接上一条，在派发 `render-process-gone` **之前**把 `nextWebContentsId = 12`，事件返回后 `getBrowser().attachGuest` 最后一次调用的参数是 `{ tabId: 'browser-9', webContentsId: 12 }`。这同时证明了 effect 因 generation 重跑——没重跑的话新节点上一个监听都没有。
5. 不可恢复崩溃不重建：`{ reason: 'launch-failed' }` 与 `{ reason: 'clean-exit' }` 各自：不出现第二个 `<webview>`（`document.querySelector('webview')` 仍是同一个 element 引用），「重新打开」按钮可见且文案含该 reason。
6. 手动重新打开：接第 5 条点「重新打开」→ 新节点出现、`src` 为 `lastRestorableUrlRef` 里的 URL。
7. 重建成功后撤销失败态：在重建出的新节点上派发 `dom-ready`，「重新打开」按钮消失。

派发自定义事件（`render-process-gone` 的载荷不在 `Event` 上，用 `Object.assign` 挂）：

```ts
const gone = new Event('render-process-gone');
Object.assign(gone, { details: { reason: 'crashed', exitCode: 1 } });
view.dispatchEvent(gone);
```

`did-fail-load` 同理：`Object.assign(new Event('did-fail-load'), { errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID', validatedURL: 'https://bad.test/', isMainFrame: true })`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock/browser/BrowserBody.test.tsx
```

预期：FAIL（没有「重试」/「重新打开」按钮，崩溃后不换节点）。

- [ ] **步骤 3：编写最少实现**

**状态（先声明清楚，别让后面的赋值凭空冒出来）**

```ts
const RECOVERABLE = new Set(['crashed', 'oom', 'killed', 'abnormal-exit']);

// 加载失败：did-fail-load 写入，did-start-loading 清空。url 是重试的目标，
// 所以从 string 改成对象（原实现只存了文案，没地方记失败的那个 URL）。
const [loadError, setLoadError] = useState<{ message: string; url: string } | null>(null);

// 进程退出：render-process-gone 的 reason，只有不可恢复的原因会写入。
const [guestFailure, setGuestFailure] = useState<string | null>(null);
```

**不引入 `isReady`**：没有任何消费者（没有文案、没有 gate、没有测试断言它），加了就是凭空多一个状态位。

**各自的 gate 与渲染**

- `loadError`：只 gate 错误行本身（含「重试」按钮）。不 gate `<webview>`、不 gate 事件接线。
- `guestFailure`：gate 失败覆盖层与「重新打开」按钮，并让 `<webview>` 走 `display:none` 隐藏——**节点留在 DOM 里**（不换 `key`、不改 `src`），第 5 条用例要比较同一个 element 引用。不 gate 事件接线：可恢复路径自己重建并重新登记。
- 两者同时成立时只渲染 `guestFailure`（进程都没了，加载失败的文案没有意义）。
- `did-start-loading`：`setLoading(true)` + `setLoadError(null)`（沿用现有行为），**不**动 `guestFailure`。
- `dom-ready`：`setGuestFailure(null)`。用 `dom-ready` 而不是 `did-start-loading` 当撤销点——重建真的要能加载出文档才算恢复。
- 覆盖层写在既有的 `.gren-browser-status .gren-browser-error` 里，内层套一个 `.gren-browser-failure` 承载文案 + 按钮。

> `index.css:116` 的 `.gren-browser-status` 是 `pointer-events: none`。按钮放在它里面**点不动**，而 jsdom 的 `fireEvent.click` 不看 `pointer-events`，测试会假绿。所以 `.gren-browser-failure` 必须把 `pointer-events: auto` 显式打开：

```css
.gren-browser-failure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}
```

**URL 复位**

`lastRestorableUrlRef`：初值 `useRef(payload.url)`；`sync()` 里解析出的 URL 非空且不是 `about:blank` 时更新。只服务崩溃重建，`did-fail-load` 不写它（失败的 URL 不算「成功导航」）。

**`did-fail-load`**

`!isMainFrame` 或 `errorCode === -3` return；否则 `setLoading(false)`、`setLoadError({ message, url })`，其中 `url = validatedURL || view.getURL() || lastRestorableUrlRef.current`。

证书类错误码单独标记文案：

```ts
// Chromium 的 ERR_CERT_* 是从 -200（ERR_CERT_COMMON_NAME_INVALID）起的区块，
// 区块末尾紧跟哨兵 ERR_CERT_END；该哨兵在 Chromium 版本间从 -219 挪到过 -220。
// 取 -219 当闭区间下界：新版里 -219 是最后一个真实证书错误，旧版里 -219 是哨兵本身
// （哨兵不会作为加载失败码上报），两种版本下都不会误标。
// 规格 §8 写的「-217～-200」偏紧，会漏掉区块尾部的条目。
const isCertificateError = (code: number) => code <= -200 && code >= -219;
```

`isCertificateError(errorCode)` 时 `message` 前缀加「证书不被信任：」。

「重试」→ `loadUrl(view, loadError.url)`（同一 URL 再 `loadURL`，不换节点）。

**`render-process-gone`**

```ts
const onGone = (event: Event) => {
  const view = webviewRef.current;
  if (!view || event.target !== view) return; // 换 key 之后旧节点的迟到事件
  const details = event as Event & { reason?: string; details?: { reason?: string } };
  const reason = details.details?.reason ?? details.reason;
  if (!reason) return;
  if (!RECOVERABLE.has(reason)) {
    setGuestFailure(reason); // launch-failed / integrity-failure / clean-exit：只展示失败态，不重建
    return;
  }
  void getBrowser().detachGuest({ tabId: tab.id });
  initialUrlRef.current = lastRestorableUrlRef.current;
  setWebviewGeneration((n) => n + 1);
};
```

三点说明：

- `event.target !== view` 取代原稿的 `recoveringRef`：旧节点的迟到 gone 天然被挡掉，不需要额外状态位；而 `recoveringRef` 只在 `dom-ready` 清位，重建若永远到不了 `dom-ready`（例如新 URL 直接 `did-fail-load`）就会永久卡住 `true`，之后所有崩溃都不再恢复。
- 这里的 `detachGuest` 是 §8 要求的显式动作；effect cleanup 那次是对同一 `tabId` 的幂等重复，不是漏写。
- `initialUrlRef.current` 必须显式复位。组件实例不重建，那个 ref 不会自己回到新 URL（§7）。

「重新打开」与可恢复路径共用同一套复位：

```ts
const reopen = () => {
  initialUrlRef.current = lastRestorableUrlRef.current;
  setWebviewGeneration((n) => n + 1);
};
```

`reopen` **不**清 `guestFailure`：撤销点只有 `dom-ready` 一个。否则重建出来的 guest 万一又加载失败，失败态已经自己撤掉了，用户手上没有可点的东西。


- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/dock electron/browser electron/ipc/commandCoverage.test.ts src/platform/runtime.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（仅用户要求时）

```powershell
git add electron-agent/src/features/dock/browser/BrowserBody.tsx electron-agent/src/features/dock/browser/BrowserBody.test.tsx electron-agent/src/index.css
git commit -m @"
feat(browser): rebuild crashed guests without dropping event wiring

"@
```

---

## 自检（规格覆盖）

| 规格 | 任务 |
| --- | --- |
| §2 点击不劫持、popup 新 tab、Ctrl/Cmd 外开 | 3、5、7、8 |
| §2 不创建 BrowserWindow | 3、4（永远 deny） |
| §2 `electron/browser` + `dock/browser` 双目录 | 1–9 |
| §5 will-attach 硬化（丢 preload / nodeintegration / disablewebsecurity） | 4 |
| §5 不写 `params.allowpopups`，改由 JSX 字符串承担 | 8 |
| §5 只允许 about:blank | 1 |
| §5 will-navigate、右键菜单 | 4 |
| §5 空 preload 且产物路径不变 | 5 |
| §6 判定顺序、keyUp/blur 清粘滞 | 3 |
| §6 `browser_attach_guest` / `browser_detach_guest` snake_case | 6 |
| §6 `browser-open-url`、uniqueId、同源不复用 tab | 7 |
| §6 runtime 三处（`GrenRuntimeBridge` / `browserPreviewBridge` / 访问器） | 6 |
| §7 事件表、`src` 只首挂、safeWebviewCall | 8 |
| §7 `page-favicon-updated` 挂 ref 不等 effect | 8 |
| §7 地址栏归一化与 document 白名单（`browserUrls.ts`） | 7、8 |
| §7 启动器 `about:blank` | 7 |
| §7 「更多」空按钮不动、地址栏与失败重试走 `loadURL` | 8、9 |
| §7 接线 effect 纳入重建代号、`initialUrlRef` 显式复位 | 8、9 |
| §8 失败态、证书文案、重试不换节点 | 9 |
| §8 崩溃原因集合与可恢复/不可恢复分流 | 9 |
| §8 重建后重新接线并重新登记 guest | 9 |
| §9 删 click 劫持测试、白名单用例迁为 `webviewPolicy` | 1、5 |
| §10 文件清单与 `electron.vite.config.ts` 入口 | 4、5、8 |
| §10 `index.css` 失败覆盖层的可点击性 | 9 |

占位符：无 TODO/待定。类型名全程 `WebviewGuestRegistry`、`decideWindowOpen`、`attachGuestCommand`、`nextBrowserTabId`、`openBrowserPopupTab`、`getBrowser`。
