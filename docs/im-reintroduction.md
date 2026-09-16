# IM 功能：暂缓与后期接入

当前稳定版本**不加载、不展示** IM（微信官方 bot + HTTP 网关）。源码留在仓库，本页写清怎么接回去、以及当初卸下时必须一起修的坑。

卸下原因：进程内多工作区会反复 `session_start`，两个扩展各抢一次绑定，顶栏会连弹「IM 已绑定到 …」；热重载会再弹一轮。单实例绑定、锁和子进程隔离都还没稳到能当产品功能开。

## 现在卸了什么

产品路径不再注册这两个扩展，侧栏不再露「连接」：

| 位置 | 改动 |
|---|---|
| `extensions/index.ts` | `allExtensions` / `namedExtensions` 不再导出 `im-gateway`、`im-platforms` |
| `cli/src/extension-profile.ts` | `CORE_ALWAYS_ON` 去掉这两项（Electron 白名单也不会常驻加载） |
| `extensions/package.json` | `pi.extensions` 去掉 `./im-gateway/index.ts` |
| `electron-agent` / `tauri-agent` 的 `ModuleRail.tsx` | 去掉「连接」入口 |

**没有删**实现与测试。`runtime-settings.json` 里若还留着 `WECHAT_OC_*` / `IM_GATEWAY*`，现在只是没人读，接回后会重新生效。

## 源码还在哪

### 扩展（真正干活）

| 路径 | 职责 |
|---|---|
| `extensions/im-gateway/` | HTTP webhook：`POST /message { text, replyUrl? }` 注入主人会话，下一条助手回复回 POST 到 `replyUrl`。默认关，开了才听端口。 |
| `extensions/im-platforms/` | 微信 ilink / clawbot：扫码或 token、长轮询。**不共享**主人交互会话；每条入站消息走隔离 oneshot 子进程，上下文窗口 `IM_CTX_MAX`（默认 20）。 |
| `extensions/_shared/im-binding.ts` | 进程内单例：全进程只能有一个 workspace 持有 IM。路径要做 `\` / `/` 归一，否则会把自己提示成「已绑定到自己」。 |

网关与微信都在 `session_start` 里 `claimImBinding`。没抢到的会话会 `notifyImBoundElsewhere`（同一 owner 应只 toast 一次；`release` 时不要清 `lastConflictKey`，否则 reload 又弹）。

子代理（`PI_IS_SUBAGENT=1`）**禁止**再开网关或微信长轮询，否则每个 oneshot 子进程都会抢端口 / 抢 ilink。

微信另有跨进程文件锁（`im-platforms/lock.ts`），避免多个 sidecar 各回一条。

### 桌面 UI（接回时再挂上）

| 路径 | 职责 |
|---|---|
| `src/features/connections/ConnectionsPanel.tsx` | 「连接」页：微信开关、扫码、会话镜像、网关字段（electron / tauri 各一份） |
| `src/features/layout/ModuleRail.tsx` | 侧栏「连接」入口（已注释掉） |
| `src/features/workspace/ModuleContainer.tsx` | `module === 'connections'` 仍会渲染面板，只是 rail 到不了 |
| `src/stores/wechatStatusStore.ts` | `setStatus("wechat")` |
| `src/stores/imMessagesStore.ts` | `setStatus("wechat-messages")` 只读镜像 |
| `src/features/extensionUi/ExtensionUiHost.tsx` | 把上述 status 写进 store |
| `src/features/settings/settingsSchema.ts` | `WECHAT_FIELDS`、`GATEWAY_FIELDS`（设置主页不展示，只给连接页用） |

`electron-agent/electron/agent/createWorkspaceHandle.ts` 在关掉 workspace 时 `releaseImBinding`，接回后请保留。

## 配置键

热更新走 `watchConfig`，多数不必重启进程。桌面字段标了 `effect: 'restart'` 是旧约定，以扩展里的 reconcile 为准。

**微信**

| 键 | 含义 |
|---|---|
| `WECHAT_OC_ENABLE` | `1` 启用 |
| `WECHAT_OC_TOKEN` | 已有 bot token；空则扫码 |
| `WECHAT_OC_OWNER` | 主人 `ilink_user_id`。空 = 任何人可聊，**受限模式**（禁 write / bash / 代码执行） |
| `WECHAT_OC_BOT_TYPE` | 默认 `3` |
| `WECHAT_OC_BASE_URL` | 默认 `https://ilinkai.weixin.qq.com` |
| `IM_CTX_MAX` | 每用户保留条数 |
| `IM_MODEL` / `IM_TIMEOUT_MS` | 隔离 oneshot 的模型与超时 |

**HTTP 网关**

| 键 | 含义 |
|---|---|
| `IM_GATEWAY` | `1` 启用（默认关） |
| `IM_GATEWAY_PORT` | 默认 `8765` |
| `IM_GATEWAY_HOST` | 默认 `127.0.0.1`。非 loopback **必须**设 token，否则强制回 loopback |
| `IM_GATEWAY_TOKEN` | `Authorization: Bearer …` |

## 接回清单

按顺序做，做完跑文末测试。

1. **重新登记扩展**
   - `extensions/index.ts`：import 工厂，放进 `export`、`allExtensions`、`namedExtensions`（名称必须是 `im-gateway` / `im-platforms`）。
   - `cli/src/extension-profile.ts`：加回 `CORE_ALWAYS_ON`（无 manifest，不加就不会进 Electron 白名单）。
   - 可选：`extensions/package.json` 的 `pi.extensions` 加回 `./im-gateway/index.ts`（微信工厂只走 branded `allExtensions`）。
2. **重新露出 UI**
   - 两边 `ModuleRail.tsx` 加回 `{ id: 'connections', label: '连接', Icon: Webhook }`。
   - 更新 `ModuleRail.test.tsx`（现在断言入口不存在）。
3. **删掉防回归测试**
   - `cli/src/agent-data-plugins.test.ts` 里 `parked IM extensions are not loaded…` 这条要删或改成「已加载」。
4. **先修再开：绑定与 toast**
   - 同一 owner 只提示一次（`notifyImBoundElsewhere`）。
   - 路径归一后再比 workspace。
   - `releaseImBinding` 不要清 `lastConflictKey`。
   - `im-gateway` 与 `im-platforms` 共用 `claimImBinding`，避免各弹一条。
5. **确认子进程 / 锁**
   - `PI_IS_SUBAGENT=1` 直接 return。
   - 微信文件锁在多 workspace / 多窗口下只能有一个长轮询。
6. **安全默认**
   - 未设 `WECHAT_OC_OWNER` 必须走受限工具集（`restrictedDenyTools()`）。
   - 网关无 token 不得听非 loopback。
7. **文档**
   - 改 `extensions/README.md` 表格，去掉「暂缓」。
   - 本页可改成「已接入」或删掉。

## 已知坑（接回时优先）

- **一直弹 toast**：多 workspace + 双扩展 + 热重载。见上第 4 步。
- **网关进主人全能力会话**：`POST /message` 等于主人在 IDE 里打字。端口暴露 = 远程任意命令。默认 loopback + token。
- **微信隔离 oneshot**：复用 `multi-agent/runner` 的子进程；子进程会加载全部编译扩展，必须靠 `PI_IS_SUBAGENT` 短路。
- **设置里 `effect: 'restart'` 与扩展热更不一致**：接回时统一文案，避免用户以为必须重启。

## 测试

源码还在时，扩展单测应继续绿（只是产品不加载）：

```bash
# 扩展包
npx vitest run im-gateway im-platforms _shared/im-binding.test.ts _shared/workspace-isolation.test.ts

# 产品不再加载 IM
node --import tsx --test src/agent-data-plugins.test.ts src/extension-profile.test.ts
# 在 cli/ 下跑

# 侧栏没有「连接」
npx vitest run src/features/layout/ModuleRail.test.tsx
# 在 electron-agent/ 与 tauri-agent/ 下各跑一次
```

接回后还应跑 `ConnectionsPanel.test.tsx`、`ExtensionUiHost` 里 `wechat-messages` 路由用例。
