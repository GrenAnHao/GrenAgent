# 内置 `<webview>` 事件接管

- 日期：2026-09-21
- 修订：2026-09-21 按代码审查修订（平台抽象层落点、IPC 命令命名、重建接线与首挂复位、`allowpopups` 定位、`render-process-gone` reason 取值）
- 范围：GrenAgent 桌面端坞内浏览器的 guest 硬化、popup 路由、`<webview>` 元素事件与崩溃重建
- 状态：设计已按节批准，待实现计划
- 参考：ZCode `desktopWindowChrome` + `UnifiedBrowserView` 的 webview 接管；机制对齐，落点用 Pi 的 dock，不搬 side pane / CDP / Browser Use
- 不取代：`page` 阅读 tab、`VisualPanel`、工具栏「更多」菜单、Agent 控浏览器

## 1. 背景与问题

坞内浏览器已经是 Electron `<webview>`（`BrowserBody` + `webviewSecurity` + `webviewPreload`）。「链接点了没反应」当时的补丁是 guest preload 对 `<a>` 做 `preventDefault` 并改 `location.href`，同时 `setWindowOpenHandler` 一律 deny、标签上写 `nativeWindowOpen=no`。

这套补丁会掐掉站点自己的 click 逻辑；真正的 `target=_blank` / `window.open` 在 deny 之后没有后续路由，修饰键新开仍然像死了。ZCode 的结论是：完全禁用 popup 表现为点击无响应；放任 Electron 默认处理又会弹出脱离应用的 `BrowserWindow`。正确做法是 attach 前写死 `allowpopups`，开窗交给 Chromium，再在 main 里 deny 原生窗口并路由。

`webviewSecurity.ts` 注释仍写 preload 经 `sendToHost` 开窗，代码已经改成 `location.href`，renderer 的 `gren:webview-open` 是死代码。`BrowserBody` 的 `new-window` 监听同样已死：该事件已从当前 Electron 的 WebviewTag 事件面移除，`nativeWindowOpen` 也已从 `WebPreferences` 移除。后面还要做 CDP / guest 生命周期，策略不能继续堆在窗口安全文件里。

## 2. 目标 / 非目标

**目标**

1. 普通 `target=_self` 点击由页面自己跳，guest 不再拦 click、不再劫持 `window.open`。
2. `target=_blank` / `window.open`：合法 `http:`/`https:` 在源 tab 同一侧坞新开一张浏览器 tab 并激活；Ctrl/Cmd 或 `disposition === "background-tab"` 走系统浏览器。
3. 从不创建脱离应用的 `BrowserWindow`。
4. attach 硬化、URL 白名单、元素事件（含失败与 `render-process-gone`）对齐 ZCode 的 webview 接管面。
5. main 策略放到 `electron/browser/`，renderer 事件放到 `src/features/dock/browser/`，给后续 CDP 留同一目录。

**非目标**

- JS `alert`/`confirm` 桥、滚轮续接、响应式视口、元素拾取。
- 工具栏「更多」（DevTools / 外开）从空按钮变成可用。
- Agent CDP、claim、tab 驱逐、Chrome 数据导入、截图合成层。
- 改 `page` tab、`VisualPanel`、Coding Plan 类特例。
- 同源 URL 复用 tab、后台静默开 tab 不抢焦点、外开默认改成用户设置。

**成功标准**

左键普通链接能进站点自己的导航。`target=_blank` 在同一侧坞多一张浏览器 tab，源 tab 的 webview 仍在（`display:none` 保活）。Ctrl/Cmd+点击弹出链接触发系统浏览器，且松开修饰键后下一次普通 popup 不再被「粘」成外开。非法协议既不能 attach 也不能经 popup 漏出。guest 崩溃（可恢复原因）后同一 tab 能回到崩溃前 URL，且重建后的 webview 仍能同步地址栏与标题、仍能开 popup tab。

## 3. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 机制 | main 权威路由（WindowOpenHandler）；guest 不拦 click |
| 模块 | 现在就建 `electron/browser/` 与 `src/features/dock/browser/`，本期只放用到的文件 |
| Popup 落点 | 源 tab 同一侧坞；找不到源则右坞 |
| 修饰键 | Ctrl/Cmd 或 `background-tab` → `shell.openExternal` |
| 同 URL | 每次新开，不复用 |
| 启动器初始 URL | `about:blank`，不再打开 example.com |
| Attach / 主文档白名单 | `http:` / `https:` / `about:` |
| Popup 白名单 | 仅 `http:` / `https:` |
| `about:` | 允许 `about:blank`；其它 `about:*` 拒绝 |
| `data:` / `file:` / restore 协议 | 不引入 |
| `nativeWindowOpen` | 不设 `=no` |
| `nodeIntegrationInSubFrames` | 本期不开启（没有对话框 preload 要进 iframe） |
| 右键菜单 | 行为保持，文件挪到 `webviewContextMenu.ts` |
| 非活动 tab | 继续 `TabBodyStack` 的 `display:none`，不卸 webview |
| Favicon | 写入 payload，工具栏这一期不展示图标 |

## 4. 架构

```
Renderer  <webview>  (dock/browser/BrowserBody)
    │  did-attach: { tabId, webContentsId }
    ▼
Main  electron/browser/attachEmbeddedWebview(embedder)
    ├ webviewPolicy     will-attach 策略（sandbox/preload 收紧 + allowpopups 就位）+ will-navigate 白名单
    ├ webviewPopup      setWindowOpenHandler（一律 deny）+ Ctrl/Cmd 外开
    ├ webviewGuestRegistry   tabId ↔ webContentsId（内存，不持久化）
    └ webviewContextMenu
    │
    ├ popup http(s) ── gren:event:browser-open-url ──► dock 同坞新 tab
    └ Ctrl/Cmd 或 background-tab ── shell.openExternal
```

`electron/main.ts` 只调用 `attachEmbeddedWebview(embedder)`。现有 `electron/webviewSecurity.ts`、`electron/webviewPreload.ts` 删除，避免两套入口；`webviewSecurity` 的白名单用例迁到新目录，`webviewPreload` 的 click 劫持单测删除。

后续 Agent 控制往 `electron/browser/` 加 guest 注册 / CDP，renderer 仍是 dock tab，不引入第二套面板。

## 5. Main 硬化

入口：`attachEmbeddedWebview(embedder: WebContents)`。

**`will-attach-webview`**

1. 写死 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、preload 为打包后的 `webviewPreload.js`。
2. 删除 params 上的 `preload`、`nodeintegration`、`disablewebsecurity`；`allowpopups` 不在这一步处理，见下条。
3. `allowpopups` 必须在 attach 完成前就位（React 事后 `setAttribute` 来不及）：JSX 属性是主路径，main 侧写回是冗余保险。这一步**是刻意的能力放宽，不是硬化**——`params` 的 `allowpopups` 由 renderer 的 `BooleanAttribute.getValue()` 产出（boolean），而 `will-attach-webview` 的 `params` 在本仓库 d.ts 里签名是 `Record<string, string>`，实现时需显式收敛类型；落地前先做一次最小验证确认 main 侧写回确实生效，验证不确定就退回只依赖 JSX 属性。真正的安全边界是 §6 的一律 deny，不是这一步。
4. `params.src` 不在 attach 白名单 → `event.preventDefault()`，guest 不创建。

**`will-navigate`**

只拦主文档。URL 不在 attach 白名单则 `preventDefault`，guest 停在当前页。子 frame 本期不单独建名单。

**Guest preload**

不再拦截 click，不再替换 `window.open`。没有滚轮续接，没有 `alert` 桥。

**右键**

现有项保持：后退 / 前进 / 刷新；可编辑时剪切复制粘贴；合法链接则当前页打开、系统浏览器打开、复制地址；检查元素。

## 6. Popup 路由与 IPC

`setWindowOpenHandler` 永远 `{ action: "deny" }`。

判定顺序：

1. 不是 `http:`/`https:` → 打日志，丢掉。
2. 当前按着 Ctrl/Cmd，或 `disposition === "background-tab"` → `shell.openExternal(url)`。
3. 其余（`foreground-tab` / `new-window` / `default` / 普通 `window.open`）→ 向该 embedder 推送打开内置 tab。

Ctrl/Cmd 用 guest `before-input-event` 记录。`keyUp` 且键本身是 Meta/Control 时必须清掉粘滞，不能用「最近一次 input 仍带 modifier」一直外开。`before-input-event` 只在 guest 有焦点时触发，所以还要在 guest `blur` 和宿主窗口失焦时各清一次。判定顺序里的 `background-tab` 已覆盖「在链接上按住 Ctrl/Cmd 点击」，修饰键这一支只对「按住修饰键时的 JS `window.open()`」生效，不要把它扩散成默认外开。

**Guest 登记**

- Renderer `did-attach`：`invoke` `browser_attach_guest`，载荷 `{ tabId, webContentsId }`。`did-attach` 是无载荷 DOM 事件，`webContentsId` 取 `getWebContentsId()`；若 attach 早于接线完成导致登记没发出，接线结束后补一次。Main 用 `webContents.fromId` 确认 `getType() === "webview"` 后写入内存表。
- 关 tab、组件卸载、`render-process-gone` 换代前：`browser_detach_guest` `{ tabId }`。guest `destroyed` 时 main 也删条目。
- 两个命令按本仓库约定用 snake_case 注册（`registerCommand`），落在 `electron/ipc/register.ts`。
- 表不持久化。登记失败或找不到源时，新 tab 落到右坞（与启动器快捷键一致）。

**打开内置页（main → renderer）**

沿用现有 `gren:event:` 前缀，事件名 `browser-open-url`：

```ts
{
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  sourceTabId?: string;
}
```

Renderer：校验 `http:`/`https:`，否则丢弃。`addTab({ kind: "browser", region, payload: { url, title: "浏览器" } })`，激活并展开该侧。id 走 `openLauncherTab.ts` 现成的 `uniqueId()`，不要用 `browser-${Date.now()}`——站点批量 `window.open` 会同毫秒撞 id。展开复用 `revealRegion`（现 `openLauncherTab.ts` 与 `dockStore.ts` 各一份，新路径不要再抄第三份）。新 `<webview>` 用 payload URL 做首挂 `src`，不先挂 `about:blank`。不回头改源 webview。

Preload 暴露 `gren.browser.attachGuest` / `detachGuest`，并同步 `src/platform/runtime.ts` 的 `GrenRuntimeBridge`、`browserPreviewBridge` 兜底与访问器三处——renderer 一律经这层，不直接碰 `window.gren`。事件用现有 `listen("browser-open-url", …)`。

## 7. Renderer 事件与生命周期

`BrowserBody` 只负责工具栏和 `<webview>`。事件接线、`safeWebviewCall`、popup 开 tab 放在 `src/features/dock/browser/`。

**节点**

- `partition="persist:gren-browser"`；JSX 上就要有 `allowpopups`。
- 去掉 `webpreferences="nativeWindowOpen=no"`（该选项已从本仓库 Electron 的 `WebPreferences` 移除，留着是无效值）。
- `src` 只用于首挂；地址栏和失败重试走 `loadURL`。
- 启动器与空 payload：`about:blank`。
- `getURL` / `canGoBack` / `loadURL` 经 `safeWebviewCall`：未 attach 或 `Render frame was disposed` 吞掉并 debug，其它错误抛出。
- 事件接线的 effect 必须把「重建代号」纳入依赖：给 `<webview>` 换 `key` 不会重跑只依赖 `tab.id` 的 effect，重建后新节点会一个监听都没有（§8）。同理首挂 URL 也不能沿用挂载时抓的 ref——组件实例不重建，那个 ref 不会自己复位，重建时必须显式用 §8 的恢复 URL 重置。

**元素事件（不听 `new-window`，不听 `gren:webview-open`）**

| 事件 | 行为 |
| --- | --- |
| `did-attach` | 向 main 登记 `{ tabId, webContentsId }` |
| `dom-ready` | 同步 url / 前进后退 / 标题；消费排队中的 `loadURL` |
| `did-start-loading` | loading=true，清错误 |
| `did-stop-loading` / `did-navigate` / `did-navigate-in-page` | 同步 chrome，写回 `dockStore` payload |
| `page-title-updated` | 更新 tab 标题 |
| `page-favicon-updated` | 写入 `BrowserPayload.faviconUrl`（挂在 ref 上，不等 `useEffect`） |
| `did-fail-load` | 见 §8 |
| `render-process-gone` | 见 §8 |

地址栏：无协议补 `https://`；显式非法协议不调用 `loadURL`。

`BrowserPayload`：`{ url: string; title?: string; faviconUrl?: string }`。工具栏「更多」空按钮不动。

## 8. 失败与崩溃

**加载失败（guest 还活着）**

主 frame `did-fail-load` 且 `errorCode !== -3`：记下 `errorDescription`、`errorCode`，停 loading，地址栏优先 `validatedURL`。证书类错误码 `-217`～`-200` 单独标记（实现时按 Chromium `net_error_list.h` 的 `ERR_CERT_*` 区块核对边界，该区间是近似），文案可提「证书不被信任」；本期不做忽略证书开关。提供「重试」：对同一 URL 再 `loadURL`，不换 `<webview>` 节点。子 frame 失败忽略。

**进程退出（画面没了）**

`render-process-gone`（本仓库 Electron 的 reason 只有 `clean-exit` / `abnormal-exit` / `killed` / `crashed` / `oom` / `launch-failed` / `integrity-failure`）：

- 可恢复：`crashed` / `oom` / `killed` / `abnormal-exit`。先 `detachGuest`，再给 `<webview>` 换 `key` 原位重建，首挂崩溃前最后一次成功 URL。
- 不可恢复：`launch-failed` / `integrity-failure`。只展示失败态和手动重试，避免空 guest 死循环。
- `clean-exit` 归入不可恢复：正常退出不是崩溃，重建没有意义。
- 重建换代后必须按 §7 重新接线并重新登记 guest，否则新 guest 不再受管。
- 重建未完成时忽略重复 gone。

**Popup / 外开**

`openExternal` 失败只打日志，不改当前页。

## 9. 测试

- `webviewPolicy`：允许 `https` / `http` / `about:blank`；拒绝 `javascript:` / `file:` / 其它 `about:` / `data:`；远程 preload 被丢；`allowpopups` 按 §5 结论断言（默认沿用 JSX 属性，main 写回验证通过后再断言强制打开）。
- `webviewPopup`：非法 URL deny 且不 IPC、不外开；普通 disposition → `browser-open-url`；Ctrl/Cmd 与 `background-tab` → `openExternal`；修饰键 keyUp 后下一次普通 popup 走内置 tab；guest `blur` 或宿主窗口失焦后也要清掉粘滞（覆盖收不到 keyUp 的情形）。
- `webviewGuestRegistry`：只接受 `webview` 类型；destroy / detach 后反查为空。
- `BrowserBody`：不再断言 `nativeWindowOpen=no`；不再用 `new-window` 导航当前页；子 frame / `-3` 不进错误态；`did-attach` 调用 `attachGuest`。
- dock：`browser-open-url` 带 `sourceTabId` → 与源同坞新开并激活；无 source → 右坞。同一毫秒连续两次 popup 的 tab id 不重复。启动器新建浏览器初始 URL 为 `about:blank`。
- 删除（不是改写后保留）`electron/webviewPreload.test.ts` 的 click 劫持单测（`findAnchor` / `window.open` → `location.href`）；`webviewSecurity.test.ts` 的白名单用例随逻辑迁为 `webviewPolicy` 测试。
- 主进程三个模块的单测沿用 `electron/devtoolsShortcut.test.ts` 的骨架（`vi.mock('electron')` + 假 WebContents + 手动派发 `before-input-event`），不新造 mock。

## 10. 文件

**新建 / 迁入**

- `electron-agent/electron/browser/attachEmbeddedWebview.ts`
- `electron-agent/electron/browser/webviewPolicy.ts`
- `electron-agent/electron/browser/webviewPopup.ts`
- `electron-agent/electron/browser/webviewGuestRegistry.ts`
- `electron-agent/electron/browser/webviewContextMenu.ts`
- `electron-agent/electron/browser/webviewPreload.ts`（从 `electron/webviewPreload.ts` 迁入并删掉 click 劫持）
- `electron-agent/src/features/dock/browser/BrowserBody.tsx`（从 `features/dock/` 挪入）
- `electron-agent/src/features/dock/browser/BrowserBody.test.tsx`（随 `BrowserBody.tsx` 挪入，相对 import 由 `../../stores/dockStore` 改为 `../../../stores/dockStore`）
- `electron-agent/src/features/dock/browser/safeWebviewCall.ts`
- `electron-agent/src/features/dock/browser/openBrowserPopupTab.ts`

**修改**

- `electron/main.ts`：改 attach 入口
- `electron.vite.config.ts`：`webviewPreload` 入口改到 `electron/browser/webviewPreload.ts`（产物路径仍是 `preload/webviewPreload.js`，policy 里的 preload 路径不用改相对段）
- `electron/ipc/contracts.ts`、`electron/preload.ts`：guest 登记与 `browser-open-url`
- `electron/ipc/register.ts`：注册 `browser_attach_guest` / `browser_detach_guest`
- `src/platform/runtime.ts`、`src/platform/runtime.test.ts`：`GrenRuntimeBridge` / `browserPreviewBridge` / 访问器补 browser 面
- `src/stores/dockStore.ts`：`BrowserPayload.faviconUrl`（启动器初始 URL 在 `openLauncherTab.ts`，不在此文件）
- `src/features/dock/openLauncherTab.ts`：浏览器 tab `url: "about:blank"`；导出 `uniqueId` / `revealRegion` 供 popup 路径复用
- `src/features/dock/TabBodyRenderer.tsx`：改 import
- `src/platform/webview.d.ts`：去掉 `webpreferences` 声明（可选清理）

**删除**

- `electron/webviewSecurity.ts`；其中白名单用例迁为 `webviewPolicy` 测试后，原文件与 `electron/webviewSecurity.test.ts` 一并删除
- 根目录 `electron/webviewPreload.ts` 及其测试 `electron/webviewPreload.test.ts`（click 劫持单测不留）

`TabBodyRenderer` 的 `browser: BrowserBody` 映射保持，只改路径。
