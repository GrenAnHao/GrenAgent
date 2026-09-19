# Pi Package 扩展面板与官方市场

- 日期：2026-09-16
- 状态：规格已完成代码实地核查与修正（见 §0），可进入 writing-plans
- 主题：侧栏「扩展」模块把 MCP 正名；新增扩展管理页；用 npm `keywords:pi-package` 检索，经 SDK `DefaultPackageManager` 安装到官方目录，空闲后 `session.reload()` 动态载入。

> **裁决记录（2026-09-16）**
>
> - **顶栏：** `MCP` / `扩展` / `技能`。市场不单独占 tab。
> - **市场入口：** 扩展页「浏览市场」打开模态，在模态里搜索、确认、安装。
> - **可管范围：** 只开关 / 卸载 `settings.json` `packages` 里用户或项目安装的包。内置扩展展示且开关禁用。
> - **安装范围：** 模态可选用户级（默认）或当前项目。
> - **生效：** 写入官方 settings 后调用已有 `requestResourceReload()` → `waitForIdle()` → `session.reload()`。不重开工作区。回合进行中则排队等到空闲。
> - **确认：** 每次从市场执行安装都弹确认（包名、版本、来源 `npm:`、范围、完整权限说明）。
> - **数据源：** 与 [pi.dev/packages](https://pi.dev/packages) 相同：npm search `keywords:pi-package`。不内嵌 pi.dev，不自研下载器。
> - **本轮不做：** Chord 实验 Plugin、git / 本地路径安装、关闭内置扩展、侧栏新入口。

## 0. 规格审查记录（2026-09-16，对照代码实地核查）

对 SDK 0.85.1 与本仓源码逐条核对后的修正。未列出的断言均已核实无误：ModuleRail `extensions`/`Plug`（`ModuleRail.tsx:19`）、tab union `'mcp'|'skills'` 默认 `'mcp'`（`ExtensionsPanel.tsx:161`）、MCP tab 现为「插件」+`Boxes`+`ext-tab-mcp`（:299-306）、`requestResourceReload`（`extensions/_shared/resource-reload.ts`）、AgentHost 150 ms 防抖 + `waitForIdle` + `session.reload()`（`agentHost.ts:90-101`、`workspaceHandle.ts:150-154`）、`{cwd, agentDir, settingsManager}` 三字段必填、`{local}` options、`autoload:false` 语义、`projectTrusted` 默认 `true`、`experimental/plugin` 已随 `files` 排除、`PI_OFFLINE`、六个插件 id、`createStaticStyles`（`src/components/PanelHeader.tsx:8`）。

| # | 级别 | 问题 | 修正 |
| --- | --- | --- | --- |
| M1 | 必须修复 | §3.1 `enabled` 无法由 `listConfiguredPackages()` 推导——`ConfiguredPackage` 无 `autoload`，`filtered` 只表示 object 形式 | 改按 scope 读原始 `PackageSource`；见 §3.1 |
| M2 | 必须修复 | §5 `setEnabled` 用 `getPackages()`（合并视图）+ `setPackages()`（写用户）会把项目级包复制进用户 `settings.json` | 改为按 scope 分别 `getGlobal/ProjectSettings()` + `setPackages/setProjectPackages()`；见 §5 |
| M3 | 必须修复 | §3.1 内置集合手写推导；`selectAllowedExtensions()` 不含 `CORE_ALWAYS_ON`，误用只剩 6 项 | 改为复用 `filterManagedExtensions(filterExtensionsByProfile(...))`；见 §3.1 |
| M4 | 必须修复 | §5 称 `agentDir` 与 SettingsService 相同——`settingsService.ts` 无该字段 | 改为指向 `main.ts:89`；见 §5 |
| M5 | 建议修改 | `removeAndPersist` 返回 `Promise<boolean>`，规格未定义 `false` 分支 | 见 §3.2 |
| S1 | 建议修改 | 搜索结果约 9,908 条，`size=20` 仅覆盖 0.2% | 模态底部显示总数；见 §4.1 |
| S2 | 建议修改 | 用户输入未净化，冒号会被解析为 npm 限定符 | 加字符白名单；见 §4.1 |
| S3 | 建议修改 | §7 称 `from` 有上限——实测 9,800 仍可用，归因错误 | 改为相关性排序 + 只取前 20；见 §7 |
| S4 | 建议修改 | 确认框用 `Modal.confirm` 与「必须可测」冲突 | 改独立小模态 + 补齐 testid；见 §6 |
| S5 | 建议修改 | §8 缺跨 scope 回归断言 | 补 M2 防回归用例；见 §8 |

## 1. 目标

用户能在 GrenAgent 里用官方 Pi Package 机制装第三方扩展，而不把 MCP 继续叫「插件」。

成功标准：

1. 顶栏第一个 tab 文案为「MCP」，图标为 lucide `Server`；`data-testid` 仍为 `ext-tab-mcp`。技能 tab 不变。
2. 新增「扩展」tab（`data-testid="ext-tab-packages"`），列出内置只读项 + 已配置 Pi Package。
3. 「浏览市场」模态能按关键词搜索 `pi-package`，展示名字、简介、版本、发布者。
4. 确认后 `packageManager.installAndPersist("npm:<name>@<version>", { local })` 写入 `~/.pi/agent/settings.json` 或 `<workspace>/.pi/settings.json`，并 `npm install` 到官方 npm 根。
5. 安装 / 卸载 / 开关成功后，已打开的 workspace 在空闲时 reload，新工具无需重启应用即可被当前会话看到。
6. 内置扩展行没有可操作开关；市场包装了才出现可关的 Switch 和卸载。

### 非目标

- 不接入 `@earendil-works/pi-coding-agent/experimental/plugin`（0.85.1 已从 npm dist 移除）。
- 不在本轮支持 `git:`、`https://`、本地路径；市场只产生 `npm:` source。
- 不关闭、不卸载编译进产品的扩展工厂（`CORE_ALWAYS_ON` 与 PluginManager ready 插件）。
- 不把 `~/.pi/agent/extensions/*.ts` 散落文件做成可管理列表（SDK 仍会加载它们，本页不展示、不提供开关）。
- 不改 PluginManager 白名单语义，不改 MCP / 技能行为，除顶栏改名与加一个 tab。
- 不内嵌 [pi.dev/packages](https://pi.dev/packages) webview。
- 不在渲染进程直连 npm registry。

## 2. 信息架构

侧栏模块保持 `id: 'extensions'`、label「扩展」、图标 `Plug`。

```
ModuleRail「扩展」
  ├─ tab MCP        现有 MCP 服务器列表（文案从「插件」改为「MCP」）
  ├─ tab 扩展       本规格新增
  └─ tab 技能       现有 NativeSkillsPanel
```

默认仍打开 MCP tab（`useState` 初值 `'mcp'`），避免改变现有用户落点。

MCP tab 与页头图标一律 `Server`，不再用 `Boxes` 表示 MCP。

## 3. 扩展页

### 3.1 列表模型

渲染序列：内置行（稳定排序按 `namedExtensions` 现有顺序）→ 用户级包 → 项目级包。

| 字段 | 内置 | 市场包 |
| --- | --- | --- |
| `kind` | `'builtin'` | `'package'` |
| `id` | 扩展目录名（如 `todo`） | `ConfiguredPackage.source`（如 `npm:@foo/bar`） |
| `title` | 目录名 | npm 包名（从 source 去掉 `npm:` 前缀） |
| `scope` | `'product'` | `'user'` \| `'project'` |
| `enabled` | 恒 `true` | 见下方 `enabled` 推导 |
| `canDisable` | `false` | `true` |
| `canRemove` | `false` | `true` |

**`enabled` 推导（易错，务必按此实现）**：`listConfiguredPackages()` 返回的 `ConfiguredPackage` 是 `{ source, scope, filtered, installedPath? }`，**不含 `autoload`**，且 `filtered` 仅表示 `typeof pkg === 'object'`（`package-manager.js:749/758`）——`{ source, autoload: true }` 也会是 `filtered: true`，因此**不能**用 `filtered` 反推开关状态。

必须按 scope 取原始 `PackageSource` 条目（`settings-manager.d.ts:61-68`）：

- 用户级：`settingsManager.getGlobalSettings().packages`
- 项目级：`settingsManager.getProjectSettings().packages`
- 判据：条目为 **string** → `enabled = true`；条目为 **object** → `enabled = entry.autoload !== false`

**内置集合**必须是「当前产品会话实际会加载的工厂」，不是仓库里全部扩展目录。不要手写 `CORE_ALWAYS_ON ∪ (allowedPluginIds ∩ namedExtensions)`，直接复用生产过滤器，保证 UI 列表与真实加载集合永不漂移：

```ts
import { manifestExtensions } from '../../../extensions/index.js';
import { filterManagedExtensions, filterExtensionsByProfile } from '../../../cli/src/extension-profile.js';

const loaded = filterManagedExtensions(
  filterExtensionsByProfile(manifestExtensions, profile ?? 'project'),
  JSON.stringify(plugins.allowedPluginIds()),
);
```

即 `cli/src/gren-runtime.ts:64-67` 的同款两段过滤。注意 **`extensions/index.ts:189` 的 `selectAllowedExtensions()` 不含 `CORE_ALWAYS_ON`**（只按 name 精确过滤，目前仅被自己的单测使用），**禁止**用它生成本列表，否则只剩 6 项。

由此：`CHAT_EXCLUDED` 且未进 `CORE_ALWAYS_ON`、又无托管 manifest 的（lsp、dap、code-exec 等）**不出现**在内置列表；出现的是 `CORE_ALWAYS_ON` 的 **23** 项 + ready 插件的 **6** 项（goal、web-search、mcp、memory、wiki-rag、code-retrieval），两者无交集，合计 **29** 行。（实测：`CORE_ALWAYS_ON` 23 项全部存在于 `namedExtensions` 的 37 项内。）

Electron 当前未设置 `EXTENSIONS_PROFILE`，默认 `'project'`（不过滤）。复用 `filterExtensionsByProfile` 是防御性的：将来若切到 `chat`，列表自动跟着裁。

项目级包仅当扩展面板拿到非空 `workspace` 时列出。没有打开工作区时，范围选择器的「当前项目」禁用，说明「先打开一个项目」。

### 3.2 操作

- **开关（仅市场包）：** 把对应 `packages[]` 条目改写成对象形式。开启：字符串 `"npm:name@version"` 或等价 `{ source, autoload: true }`（省略 resource 过滤键，加载清单内全部资源）。关闭：`{ source, autoload: false }`。官方语义：`autoload: false` 起始为空，未写正向 pattern 则不加载任何资源。磁盘上的 npm 安装目录保留。
- **卸载：** `packageManager.removeAndPersist(source, { local: scope === 'project' })`。确认文案：`确认卸载「<name>」？将从 <用户设置 | 当前项目> 移除，并停止加载。` 返回值为 `Promise<boolean>`（`package-manager.d.ts:52`），`false` 表示 settings 里没有该条目；此时仍刷新列表与 reload，但不弹错误条。
- **浏览市场：** 打开模态，不离开扩展 tab。

开关、卸载、安装成功之后都调用 `requestResourceReload()`（已有，`extensions/_shared/resource-reload.ts`）。`AgentHost` 已对所有 handle 做 150 ms 防抖 + `waitForIdle` + `session.reload()`。没有打开的 handle 时 reload 是空操作，下次 `createWorkspaceHandle` 会经 `DefaultResourceLoader` 读到新 packages。

## 4. 市场模态

### 4.1 搜索

主进程 `GET https://registry.npmjs.org/-/v1/search`：

- `text`：`keywords:pi-package` 与用户输入 `trim` 后用空格拼接。输入为空则只有 `keywords:pi-package`。
- `size`：`20`。不翻页（本轮）。不传 `from`。

**输入必须净化**：npm search 的 `text` 支持 `keywords:` / `author:` / `maintainer:` / `is:` 等限定符语法。用户输入里的冒号会被当成限定符解析，导致查询语义漂移甚至空结果。拼接前把输入收缩到 `[\p{L}\p{N}\s@/._-]`（其余字符替换为空格后再 `trim`），不含 `:` 与引号。

**结果集规模需如实呈现**：实测 `keywords:pi-package` 精确命中约 **9,908** 个包（在 `from` = 0 / 50 / 200 / 1000 处抽样，各 20/20 命中该 keyword）。`size=20` 只覆盖约 0.2%，且顺序由 npm 相关性决定。模态底部须显示 `共 <total> 个结果，展示前 20 个`，避免用户误判为「没有这个包」。

映射每条 `objects[].package`：

```ts
{
  name: string;
  version: string;
  description: string;
  publisher: string; // package.publisher.username，缺省空串
  npmUrl: string;    // https://www.npmjs.com/package/<name>
}
```

渲染进程禁止自己 fetch registry。失败时模态内错误条显示 `市场搜索失败：<短消息>`，列表保持上一次成功结果（首次失败则空列表）。

已在 `package_list` 里出现、且 npm 名相同的结果，按钮为「已安装」且禁用安装（不同 scope 已装也算已安装）。不在本轮做「升级到搜索结果版本」。

### 4.2 安装

用户点「安装」：

1. 若未选工作区且范围是项目：不允许提交。
2. 弹出确认。正文固定包含：包名、版本、source `npm:<name>@<version>`、范围（用户级 / 当前项目）、以及「该包将以本机完整权限运行，可执行任意代码。」确认按钮文案「确认安装」。
3. 确认后 `installAndPersist("npm:<name>@<version>", { local: scope === 'project' })`。版本钉死为搜索结果里的 `version`，与确认框一致。
4. 安装期间模态内该行显示进行中，禁止重复点。`invoke` 等到 npm 结束。
5. 成功：关闭确认框、刷新列表、`requestResourceReload()`。模态保持打开，该行变为「已安装」。
6. 失败：确认框或模态错误条显示 SDK / npm 原文（截断到 300 字符），不关闭模态。

`DefaultPackageManager` 的 `setProgressCallback` 本轮不接到 UI；只用按钮 loading。

## 5. 主进程 `PiPackageService`

新建 `electron-agent/electron/app/piPackageService.ts`。

构造依赖：

- `agentDir: string`，与 `main.ts:89` 同一表达式：`process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')`。（注：`SettingsService` 并不持有 `agentDir`，该表达式目前在 `main.ts` 的 80 / 89 / 220 / 238 行各写了一遍；本服务从 `main.ts` 注入，不新造一份。）
- `allowedPluginIds: () => string[]`：构造时注入（传 `() => plugins.allowedPluginIds()`，与 `main.ts:234` 给 `PiRuntimeService` 的同款回调），供 §3.1 的内置列表计算。服务不直接依赖 `PluginManager`。
- 每次调用传入 `workspace: string`（可空）。用 `SettingsManager.create(workspace || agentDir, agentDir)` + `DefaultPackageManager({ cwd, agentDir, settingsManager })`。三个构造字段全部必填（`package-manager.d.ts:68-72`）。`workspace` 为空时 `projectTrusted` 无意义，只读写用户 settings。

对外方法：

| 方法 | 行为 |
| --- | --- |
| `list(workspace)` | 内置快照（§3.1）∪ `listConfiguredPackages()`。后者是 `DefaultPackageManager` 的方法（非 `SettingsManager`），一次返回 user + project 两个 scope，条目自带 `scope` 字段 |
| `search(query)` | npm search，纯函数映射，不读 settings |
| `install(workspace, name, version, scope)` | 校验 name/version，拼 `npm:` source，`installAndPersist` |
| `remove(workspace, source, scope)` | `removeAndPersist` |
| `setEnabled(workspace, source, scope, enabled)` | 见下方「按 scope 读写」，按 source 身份（npm 包名，忽略已有 ref）替换条目后写回 |

### `setEnabled` 必须按 scope 分别读写（数据损坏风险）

`getPackages()` 返回的是**合并后**的 `this.settings.packages`（`settings-manager.js:721-722`），而 `setPackages()` 写的是 `this.globalSettings.packages`（`:724`）。若按「读 `getPackages()` → 改 → `setPackages()`」实现，项目级包会被复制进用户 `settings.json`，正是本规格要禁止的跨 scope 污染。正确做法：

| scope | 读 | 写 |
| --- | --- | --- |
| `user` | `settingsManager.getGlobalSettings().packages` | `settingsManager.setPackages(next)` |
| `project` | `settingsManager.getProjectSettings().packages` | `settingsManager.setProjectPackages(next)` |

两处 `get*Settings()` 均为公开方法（`settings-manager.d.ts:174-175`）。身份规则与官方一致：npm 按 package name（`npm:<name>`），不按 version ref——见 `package-manager.js:1364-1374` 的 `getPackageIdentity`。开启写 string 形式（或 `{ source, autoload: true }`），关闭写 `{ source, autoload: false }`，其余资源过滤键（`extensions` / `skills` / `prompts` / `themes`）原样保留，不要丢。

安装 / 卸载 / 开关成功后服务自己调 `requestResourceReload()`，调用方不必再调。

### IPC

在 `register.ts` 增加（命名对齐 `list_mcp_configs`）：

- `package_list`
- `package_search`
- `package_install`
- `package_remove`
- `package_set_enabled`

同时给 `register.ts:28` 的 `IpcServices` 接口加 `piPackages?: PiPackageService`（其余字段均为可选）。`main.ts` 在 `plugins` 构造之后（`main.ts:176` 之后、`registerIpcHandlers` 的 `:211` 之前）构造 `PiPackageService` 并注入。渲染层 `src/lib/pi.ts` 按现有驼峰→snake_case 风格增加对应方法（`packageList` / `packageSearch` / `packageInstall` / `packageRemove` / `packageSetEnabled`）。

## 6. UI 拆分

- `ExtensionsPanel.tsx`：tab 类型改为 `'mcp' | 'packages' | 'skills'`；MCP 文案与图标；第三分支渲染扩展页。
- 新建 `PiPackagesPanel.tsx`：列表 + 浏览市场按钮。
- 新建 `PackageMarketplaceModal.tsx`：搜索、结果、范围、确认。
- 样式继续用 `createStaticStyles` + `@lobehub/ui` 的 `Button` / `Modal` / `Switch`，图标 lucide + `@lobehub/ui` 的 `Icon`。禁止 emoji。

确认框用**独立小模态**，不用 antd `Modal.confirm`——后者渲染在 React 树外，`screen.getByTestId` 抓不到，与「必须可测」冲突。

必需的 `data-testid`：

| testid | 位置 |
| --- | --- |
| `ext-tab-packages` | 扩展 tab（成功标准 2） |
| `package-marketplace-modal` | 市场模态根节点 |
| `package-marketplace-search` | 搜索输入框 |
| `package-install-<name>` | 结果行安装按钮 |
| `package-install-confirm` | 确认框根节点 |
| `package-row-<source>` | 扩展页每行（`source` 需转义，或用序号） |
| `package-remove-confirm` | 卸载确认框 |

## 7. 错误与边界

- 新包 / 长尾包可能搜不到：不是 `from` 上限——实测 `from` = 250 / 1000 / 5000 / 9800 均返回 200 与完整结果，该端点无硬性分页上限。真实原因是排序按 npm 相关性而非发布时间，而本轮只取前 20（见 §4.1 的 9,908 总量）。与官方画廊同一限制，本轮接受；不做全量爬取，也不在 UI 上暗示「已列出全部」。
- `name` 必须匹配 `^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$`，`version` 必须是 semver 字符串，否则 install 抛 `INVALID_PACKAGE`。
- 项目未信任：SDK 默认 `projectTrusted = true`。本轮不新增 trust UI；项目范围安装直接写 `.pi/settings.json`。
- 与内置同名的市场包：允许安装。加载顺序仍是 SDK 的 resource 去重 + 我们的 inline `extensionFactories`。UI 两行都在，内置行标注「内置」。
- 离线：`PI_OFFLINE` 时 `DefaultPackageManager` 已有离线行为；搜索仍会因网络失败而报错。

## 8. 测试

| 文件 | 断言 |
| --- | --- |
| `ExtensionsPanel.test.tsx` | 三个 tab；MCP 按钮文本为「MCP」；存在 `ext-tab-packages`；无 `ext-tab-code-intel` |
| `electron/app/piPackageService.test.ts` | search 把 registry JSON 映成 DTO；install 调 `installAndPersist` 且 source 含钉死版本；成功路径调用 `requestResourceReload`；非法 name 拒绝；**`setEnabled` 关闭项目级包后 `setPackages`（用户）未被调用，且用户 `settings.json` 内容不变**（M2 防回归，最高优先级）；**`setEnabled` 关闭用户级包后 `setProjectPackages` 未被调用**；object 形式条目改写时保留原有 `skills` / `extensions` 等过滤键；`list` 的 `enabled` 对 string 条目为 `true`、对 `{autoload:false}` 为 `false`（不得用 `filtered` 反推） |
| `PackageMarketplaceModal.test.tsx` | 搜索框触发 search；安装先出确认，取消则不 invoke install |
| `cli/src/extension-profile.test.ts` | 不改加载白名单语义（本规格不碰 filter 逻辑） |

主进程测试 mock `fetch` 与 `DefaultPackageManager`，不打真实 npm。

## 9. 文档

实现完成后改 `docs/architecture.md`「extensions —— 内置扩展包」一节（现为第 44-48 行）：补一句桌面端经 `PiPackageService` 管理 `settings.packages`，市场检索 npm `keywords:pi-package`；并说明扩展页的内置列表复用 `filterManagedExtensions(manifestExtensions, allowedPluginIds)`，与实际加载集合同源。不改 `docs/pi/packages.md`（那是上游摘录）。
