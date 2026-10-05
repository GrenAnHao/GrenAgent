# 设计模式规格 · 审查报告

**审查对象：** `docs/superpowers/specs/2026-09-26-design-mode-design.md`（613 行，状态：设计已按节批准，待拆分 M0–M5）
**审查方式：** 以仓库代码为唯一依据，逐条核实规格引用的 Pi SDK API、现有文件、路径与既有实现；未核实项明确标注。审查范围按用户要求：功能需求完整性、技术方案合理性、接口定义清晰度、遗漏的边界场景与风险。
**SDK 版本核实：** `extensions/package.json` 声明 `@earendil-works/pi-coding-agent@^0.87.0`，实际安装 `extensions/node_modules/@earendil-works/pi-ai@0.87.0`。规格第 7 行写「Pi SDK 0.87.1」，与仓库不符（见 F1）。
**缩写：** `SDK/` = `extensions/node_modules/@earendil-works/pi-coding-agent/dist/`；`MODES` = `extensions/agent-mode/modes.ts`；`QUEST` = `extensions/agent-mode/questions.ts`；`PRS` = `electron-agent/electron/app/piRuntimeService.ts`；`WVP` = `electron-agent/electron/browser/webviewPolicy.ts`；`GIT` = `electron-agent/electron/app/gitService.ts`；`DC` = `extensions/_shared/desktop-control.ts`。

---

## 〇、总体结论

这是一份质量明显高于同类规格的文档：D1–D17 的决策表、六节设计、38 行对齐矩阵、文件级改动清单、按里程碑可验收的标准，结构完整；路径约定（第 10 行）与「不取代」清单（第 8 行）这类元信息也很少见。**核实过的 SDK 与仓库假设基本全部成立**——这是我逐条查过后的判断，不是客套：

| 规格引用 | 核实结果 |
|---|---|
| `before_agent_start` 写 `event.systemPromptOptions.sections` | ✅ `SDK/core/system-prompt.d.ts:21`（`sections?: Record<string,string>`）、`SDK/core/extensions/types.d.ts:555-572` |
| Pi 对 sections 做差异追加 | ✅ `SDK/core/system-prompt.d.ts:66-70` `diffSystemPromptSections` |
| `agent_before_settle` + `BoundaryResult.entries` / `continue` | ✅ `types.d.ts:572-607,619-622` |
| `agent_settled` 在重试/压缩/排队续跑后触发 | ✅ `types.d.ts:623-626` 注释 |
| `pi.setActiveTools` | ✅ `types.d.ts:1074` |
| `tool_call` 可阻断、`tool_result` 可改写内容 | ✅ `types.d.ts:784-797`；`extensions/after-tool-feedback/render.ts:16-21` |
| `sessionManager.appendCustomEntry(type, data)` | ✅ `SDK/core/session-manager.d.ts:266`、`session-manager.js:901-912` |
| 「首条助手消息前条目留内存，首条回复时落盘」 | ✅ `session-manager.js:785-813`（`_persist`：无 assistant 消息时不写盘，只进 `fileEntries`） |
| 主进程可写会话条目 | ✅ 已有先例 `PRS:604` `s.setSessionName(name)` |
| `desktopControl().request(method, params)` | ✅ `DC:5-11`（`MemoryClient`） |
| 预览可用 `http://127.0.0.1` | ✅ `WVP:1-13` `DOCUMENT_PROTOCOLS = {http:, https:}` |
| `gitService` 存在但无 init/commit | ✅ `GIT:15-79`，`execFile('git', …)` |
| `tempHtmlService` 存在（矩阵 #20） | ✅ `electron-agent/electron/app/tempHtmlService.ts` |
| `permission.authorize` 可走网络审批 | ✅ `electron-agent/electron/main.ts:150` |
| `ensureWorkspace` | ✅ `electron-agent/electron/app/workspaceService.ts:64` |

但规格存在 **6 个实施前必须解决（P0）**的问题，其中两个会直接卡住 M0 或 M1 验收；另有 **接口定义层面的系统性缺口**——11 个新工具没有一份完整的参数 schema 或返回值契约，第 12 节「无待定 / TODO」的自检在这一维度上不成立。

**结论：建议「有条件批准」**。条件是在拆分 M0–M5 实现计划之前，先修掉第二节的 6 项 P0，并补上第四节的接口契约。不建议带着当前文本直接进入计划拆分。

---

## 一、按节审查意见

### §1 背景与目标

**核实：** 三层结构、`AGENT_MODE:<cwd>`（MODES:20-23）、坞内浏览器 webview、`visual-companion`、`ask_user`、`spawn_agent`、AgentData 记忆，均在仓库中核实存在。

**问题 1.1（完整性）** 目标第 2 条列出六类产出，但全文没有定义 `outputKinds` 的**取值枚举**。`5.2` 只出现了网页/落地页、移动、仪表盘、幻灯片、海报五类的 craft 映射；第 6 类「自家产品改版」的名称、是否作为 `outputKinds` 的一个取值、对应哪些 craft 规则，均未出现。M1 验收第 6 条只要求前五类，但 `project.json.outputKinds` 的合法值集合是 M0 就要落库的数据结构。

**建议：** 在第 4.3 节目录说明处补一张 `outputKinds` 枚举表（含中文名、英文 id、默认视口、craft 映射），并明确 `outputKinds` 是数组时多值的合并规则（并集？取首个？）。

**问题 1.2（完整性）** 目标第 4 条「收尾自动截图对照清单」隐含一个前提：系统知道「本轮写了哪些产出」。这个集合的来源全文未定义（见 P0-4）。

### §2 非目标

**评价：** 写得很好，尤其第 3 条（不移植 `official-system.ts`）和第 7 条（不引入 headless Chromium）边界清晰。

**问题 2.1（风险）** 第 7 条「不引入 headless Chromium」与 §5.5 的 MP4 逐帧导出存在张力：`document.getAnimations()` 只能控制 WAAPI 与 CSS 动画，**管不住 `requestAnimationFrame` 驱动的 JS 动画、`<video>` 播放、canvas/WebGL 绘制**。M4 验收第 5 条「HyperFrames 模板导出 MP4」如果拿 JS 驱动的模板验收，会失败。

**建议：** 在第 2 节补一条非目标：「MP4 导出仅保证 WAAPI / CSS 动画，JS 驱动动画、视频元素、WebGL 不保证」，并在导出面板提示里同步这句话。

**问题 2.2（风险）** 第 5 条「PPTX 只做每页一图」已声明，但 §7 M2 验收第 1 条只说「PPTX 导出面板显示不可编辑提示」——建议把该提示的**触发时机**写死（点击导出即弹确认，而非导出完成后提示），否则容易被实现成事后告知。

### §3 已确认的设计决定 D1–D17

**评价：** D1–D17 与第 5、6、8 节的对应关系我在抽查范围内未发现矛盾，这在长规格里不容易。

**问题 3.1（D2 / 技术方案合理性）** 白名单常量放在 `MODES` 与其它模式并列，但 `MODES:6` 的 `AgentMode` 是五值封闭联合，`toolWhitelist(mode: AgentMode)`、`activeToolsFor(mode: AgentMode, allTools)`（MODES:125-139）都以 `AgentMode` 为入参。`design` 不入枚举是对的（D1 按会话存），但规格只说「判定函数」，既没命名也没签名。

**建议：** 明确新增 `DESIGN_TOOLS` 的同时新增 `activeDesignToolsFor(allTools: readonly string[]): string[]`，沿用 `activeToolsFor` 的交集与空集回退语义（MODES:133-139 的空集回退很重要：交集为空时回退白名单本身，保证绝不放开写类工具）。

**问题 3.2（D2 / 风险）** 白名单「全部 `mcp__<server>__<tool>` 工具（按前缀放行，仍受 `mcp-policy` 约束）」与「设计会话收掉 `bash` 等」的收权原则**自相矛盾**。filesystem MCP、shell/command MCP 能读写任意文件、执行任意命令，等于绕过了整个白名单设计。规格用「仍受 mcp-policy 约束」一笔带过，但 mcp-policy 管的是连接授权，不是工具能力。

**建议：** 二选一并写进 D2：(a) 设计会话默认不启用 MCP，需用户在设置里显式打开；(b) 保持放行，但在 §10 风险表新增一行「MCP 放大设计会话能力」，给出理由（用户显式连接即授权）。当前文本两者都没做。

**问题 3.3（D3 / 接口清晰度）** sections 的键会**被包成同名 XML 标签**（`SDK/core/system-prompt.d.ts:45-49`：「every other section is wrapped in a tag of the same name」）。`design_system` 的内容是 token JSON，`design_charter` 里要写 `data-od-id` 与 EDITMODE 示例代码——这些内容含 `<`、`>`、`&`、`"`、以及 CSS 注释块 `/*EDITMODE-BEGIN*/`，存在与 section 包装层相互污染的可能。

**建议：** 明确 section 内容的转义约定（建议统一：内容不做 HTML 转义，但在测试里断言渲染后的 system prompt 中 `</design_system>` 只出现一次），并在第 9 节加一条「sections 渲染快照 + 标签闭合」断言。

**问题 3.4（D8 / 接口清晰度）** `QUEST:9-18` 的实际定义是：

```ts
export interface QuestionSpec {
  // …
  options: QuestionOption[];      // 必填
  allowMultiple: boolean;          // 必填
}
```

D8 说「`ask_user` 的每个问题新增可选 `field`」，但 `color` / `file` 两种字段**没有 options**，`options` 与 `allowMultiple` 都是必填 → 这不是「新增可选字段」，而是要**把两个必填字段改为可选**。这会穿透 `QuestionsCardData`（QUEST:22）、渲染层两个卡片组件、`inlineQuestionStore`、`restoreInlineQuestionOnLoad`、`askUserDraft` 五处，且涉及**旧草稿反序列化兼容**（磁盘上已有带 options 的草稿）。规格第 8.2 节列了渲染与草稿文件，但没列类型变更范围与兼容性策略。

**建议：** 在 D8 与 §8.2 明确：① `options` / `allowMultiple` 改为可选；② `field` 的类型联合 `{ type: "single"|"multi", options } | { type: "color", default? } | { type: "file", accept? }`；③ 旧草稿缺 `field` 时按现有行为渲染（向后兼容断言）；④ `file` 字段的 `accept` 与上传落点（`assets/uploads/`）在草稿恢复时如何还原（路径还是内容）。

**问题 3.5（D9 / 完整性）** `generate_image` 现有实现把图写到 `<cwd>/.pi/images/`（`extensions/image-gen/index.ts:75`）。D9 的 `media` 扩展合并后「普通会话同样使用新的 `generate_image`」，但 §5.5 的素材落盘规则写的是 `assets/<kind>/<时间>-<短 id>.<ext>`（相对设计项目）。**非设计会话用哪条规则？** 规格没说。

**建议：** 明确落盘规则按会话类型分流：设计会话 → 设计项目 `assets/<kind>/`；其它会话 → 沿用 `<cwd>/.pi/images/`（保持现有行为，避免回归）。

### §4 架构

**问题 4.1（§4.2 生命周期 / P0 级竞态）** 第 3 步写的是「渲染层打开该 workspace 并新建会话；**随后**调用 `design_mark_session`」。`before_agent_start` 在第一条用户消息之后触发，若 `design_mark_session` 与用户输入之间存在竞态（IPC 异步、用户快速发送），第一轮就读不到 `design-session` 条目——而 §5.1 错误处理表最后一行规定「条目缺失（旧会话）→ 视为普通会话」，即**静默降级**。用户会看到一个「设计会话」按普通 agent 模式跑完了第一轮，且没有任何提示。

**建议：** 规定 `design_mark_session` 必须在会话可接受输入之前完成（放进「新建会话」流程内 await，或在主进程打开 workspace 时同步写，参照 `PRS:604` 的 `setSessionName` 先例），并在错误处理表区分两种缺失：新建流程内缺失 = 阻断并报错；旧会话缺失 = 静默降级。

**问题 4.2（§4.2 / 幂等性）** D1 说「只写一次、不可切换」，但没规定**如何保证只写一次**。`appendCustomEntry` 每次调用都会追加一条并把 `leafId` 前移（`session-manager.js:901-912`）。渲染层重试、会话重开、或多窗口都可能写两条。

**建议：** 写入前先查已有 `design-session` 条目，存在则跳过；并在 `session_start` 钩子做一次去重兜底（取第一条）。

**问题 4.3（§4.2 / 边界场景）** 规格未定义以下三种情形下设计标记的行为：

- **会话 fork / 分支**（`multi-agent` 的 fork、会话树导航）：fork 点之前的 custom entry 会被继承，之后的不会。导航到旧节点后还是不是设计会话？
- **设计会话切换 workspace**（侧栏切换到另一个项目）：标记按会话，但 `tool_call` 的路径拦截按项目目录 → 切走之后所有 `write` 都被拦，会话变成「只能读」的半残状态。
- **普通会话打开设计项目目录**：拿到完整工具集（含 `bash`），可以随意破坏设计项目的 git 历史。

**建议：** 在 §5.1「错误处理」表或新增「边界」小节补齐这三条的规则（建议：fork 继承；切换 workspace 时提示「当前为设计会话，仅可写入 <项目目录>」；普通会话打开设计目录不特殊处理，但设计项目目录本身的 `.git` 由宿主维护、不依赖此保证）。

**问题 4.4（§4.3 目录 / 一致性）** `.gitignore` 忽略了 `exports/`、`.design/cache/` 与「清单中的大文件」。但 **git 不会因 `.gitignore` 变更而把已跟踪文件移出索引**——若素材先被提交、后加入清单，大文件已经进了历史。§5.5 只说「写入 `.gitignore`，并在清单中记录」。

**建议：** 把顺序写死：写入素材 → 立即更新 `.gitignore` 与清单 → 若该文件已被 git 跟踪则 `git rm --cached` → 再提交。并在 §9 加一条单测：先提交小文件、再将其标记为大文件，断言其不在最新提交的 tree 中。

### §5.1 核心架构（M0）

**问题 5.1.1（P0 / §5.1 错误处理表缺 git 不可用）** `GIT:70,79` 是 `execFile('git', args, { cwd, windowsHide: true })`——**依赖系统 PATH 上的 git 二进制**，仓库没有内置 git。D14 要求项目创建即 `git init`、每轮自动提交。§5.1 的错误处理表覆盖了端口占用、截图超时、页面加载失败、资产加载失败、条目缺失，**唯独没有 git 不可用**。Windows 桌面端相当比例的用户没装 git 或没加到 PATH。后果：M0 验收第 1 条（创建后目录含 `.git`）直接失败，而且是在「新建设计会话」这个最前置的路径上。

**建议：** 在错误处理表新增一行，并给出降级方案（推荐）：检测 git 可用性 → 不可用时降级为**文件系统快照**（每次提交 = 把工作树复制到 `.design/snapshots/<ts>/`，恢复 = 复制回来），在版本抽屉标注「文件系统快照模式（未安装 git）」；或（更保守）创建项目时直接阻断并提示安装 git。两种都要写清楚对 §5.3 版本列表/恢复的影响。

**问题 5.1.2（P0 / 预览 webview 的 preload 注入）** `WVP:24-43` 的 `applyWillAttachPolicy` 会**强制**给每个 webview 设 `nodeIntegration=false, contextIsolation=true, sandbox=true, preload=preloadPath`。D4 说「不放开 `file:` / `data:`」，这在 `isAllowedWebviewUrl` 层面成立；但设计预览 webview 若复用同一条 attach 路径，就会**把应用 preload（含 `window.gren` 桥）注入模型写的、可能抓取自第三方站点的 HTML**。这比 `file:` 的问题大得多。规格全文没有提到 preload / partition 隔离。

**建议：** 明确设计预览 webview 的隔离策略：① 使用独立 `partition`（如 `persist:design-preview-<projectId>` 或不持久化 partition）；② 明确是否注入应用 preload——若注入，需说明 `window.gren.invoke` 对预览页面暴露到什么程度（`design_export` 等命令是否能被页面脚本调用）；③ 建议设计预览走**不注入应用 preload** 的独立路径，仅通过 IPC 由渲染层控制。同时把这一点写进 §10 风险表与 D4。

**问题 5.1.3（技术方案）** 预览服务「`token` 为每个项目启动时生成的随机串」——「启动时」指应用启动还是项目打开？重启后 token 变化 → 持久化的 webview URL 失效。规格没说重启后预览标签页如何重新拿到地址。

**建议：** 明确「不持久化预览 URL，标签页每次挂载时重新调用 `design_preview_info`」；token 的作用域（按项目、按应用生命周期）写死；SSE 端点 `/__design/events/<token>` 必须与静态路由做同样的 token 校验（规格只说了路由带 token，没说校验）。

**问题 5.1.4（技术方案 / 性能）** 「离屏窗口池上限 2，超出排队」+ §5.2 完成钩子「对本轮写过的每个 HTML 产出截图」。若一轮产出 5 个 HTML，串行 5 次（每次含窗口加载 + 默认 500ms `waitMs`），而 `agent_before_settle` 是**阻塞**的、还可能退回 3 次 → 最坏 15 次截图。用户感知延迟未评估。

**建议：** 给完成钩子的截图设总量上限（例如每轮最多 3 个产出，超出只对前 3 个截图并在清单里说明），并把 `waitMs` 默认值在完成钩子场景下调（或用 `document.readyState` + 固定短等待）。

**问题 5.1.5（接口清晰度）** `render_screenshot` 返回「PNG 内容块 + 一行文字摘要」，但**没写 `details`**。渲染层要靠 `details` 才能在聊天里把截图与产出、视口关联起来（参考 `generate_image` 的 `details: { path, paths, model, size, count }`，`extensions/image-gen/index.ts:104`）。

**建议：** 统一约定新工具的 `details` 结构（见第四节）。

### §5.2 提示、资产、自检闭环（M1）

**问题 5.2.1（P0 / 产出概念缺失）** 「对本轮写过的每个 HTML 产出」——这个集合从哪来？规格没说。是靠 `tool_result` 钩子累积本轮写过的路径？还是扫 `artifacts/` 的 mtime？两种都不严谨（前者漏掉首轮之前的文件，后者受素材写入干扰）。同时 §4.3 说 `artifacts/`「每个产出一个文件或子目录」，但**产出的注册/发现机制全文未定义**：扫目录？还是写进 `project.json`？多个产出时预览默认打开哪个？

**建议：** 引入**产出注册表**：`.design/project.json` 增加 `artifacts: [{ id, path, kind, updatedAt }]`，由 `design-studio` 在 `tool_result`（`write`/`edit` 命中 `.html`）时维护；完成钩子、预览切换、导出菜单、版本抽屉统一读这张表。这条是 M0 的数据结构，必须与项目目录一起定，不能拖到 M1。

**问题 5.2.2（接口清晰度）** `design_catalog` 的 `read` 返回「指定 id 的正文或文件列表」——未定义结构、未定义大小上限。HyperFrames 这类大模板直接回灌会撑爆上下文，与 §10「提示过长」的应对自相矛盾。

**建议：** 统一为 `{ id, kind, source, files: [{ path, size }], content? }`；正文超过 N KB（建议 8 KB）时只给 `files` 与路径，让模型自己 `read`。`search` 的返回条数上限（建议 20）也要写。

**问题 5.2.3（完整性）** 六类产出中的**海报 / 社交图大概率是中文**，但 craft 映射表（`typography`、`color`、`anti-ai-slop`、`laws-of-ux` …）全是英文语境的规则，中文排版（行高、标点挤压、中西文混排间距、字体回退、避免日文字形）没有对应条目。

**建议：** craft 映射增加 `cjk-typography`（或明确「中文排版规则由 `design_charter` 自写小节承担」），并纳入 24,000 token 上限的测算。

**问题 5.2.4（技术方案）** 「`tool_result`：`write` / `edit` 的目标是 `.html` 时依次运行」三项检查。但模型可能把产出写成 `.htm`、或把 CSS/JS 拆成同名 `.css` / `.js` 外部文件（此时 lint 完全不触发，而 standalone 导出又要内联它们）。规格只匹配 `.html`。

**建议：** 扩展匹配规则：`.html` / `.htm`；并对同名外部资源变更也触发一次「语法检查」（至少 JS 走 `acorn`）。或在守则里禁止外部资源（但 standalone 导出又支持内联，说明是允许的）——两者要统一。

**问题 5.2.5（边界场景）** 完成钩子的自检清单要求「控制台无错误」，但页面常引入第三方 CDN（字体、图表库），离线环境必然报 `net::ERR` 控制台错误 → **必然退回 3 次然后放行**。这是会真实发生的误报。

**建议：** 区分「页面自身脚本错误」与「资源加载失败（网络/CDN）」，只对前者退回；或把网络类错误降级为 P2 提示。这条要写进清单定义。

### §5.3 导出、编辑、微调、版本（M2）

**问题 5.3.1（技术方案 / 性能）** MP4 逐帧导出（30fps × N 秒 = 数百至数千次 `capturePage`）与「离屏窗口池上限 2，超出排队」的交互未定义：导出会长时间占满池，期间 `render_screenshot` 请求饿死。且没有总时长/帧数上限——5 分钟 30fps = 9000 帧，内存与磁盘都会爆。

**建议：** 明确导出使用**独立窗口实例**（不占池中额度），并给 MP4 设上限（建议 ≤ 60 秒 / ≤ 1800 帧，超出则在导出面板提示分段）；导出任务走 `onUpdate` 报进度、可取消。

**问题 5.3.2（技术方案）** PDF 用 `printToPDF`，但模型写的 HTML 常外链 Google Fonts。**离屏窗口在无网或字体未加载完成时回退字体，导致 PDF 与预览不一致**。`waitMs` 默认 500ms 不保证字体就绪。

**建议：** 离屏渲染统一等 `document.fonts.ready`（附超时），并在导出面板提示「首次导出建议联网以保证字体一致」。幻灯片 PDF「按页边界一页一张」的实现手段（`pageRanges` 还是 CSS `break-after` / 分页容器高度）也要写明，否则 M2 验收「页数等于幻灯片数」不稳。

**问题 5.3.3（完整性）** 「点选编辑」依赖 `browserElementPicker.ts` 扩展到设计预览。但拾取脚本目前是给**浏览器标签页**写的（`electron-agent/src/features/dock/browser/browserElementPicker.ts`，344 行，含 `data-gren-element-picker` 高亮、tooltip、取消脚本）。设计预览若按 5.1.2 走独立 preload（不注入应用 preload），`executeJavaScript` 与拾取脚本的注入通道需要重新确认。

**建议：** 在 §8.3 明确 `browserElementPicker` 的复用边界：脚本注入方式（`executeJavaScript` 还是独立 preload）、`data-od-id` 回传是否依赖 `window.gren`。这两个决策与 5.1.2 耦合，必须一起定。

**问题 5.3.4（接口清晰度）** 版本列表/恢复走 IPC（`design_versions_list` / `design_version_restore`），`@rev/<sha>` 预览由预览服务 `git show` 读取。但**恢复后（工作树变为旧版本）预览服务的 git 读取与工作树状态的一致性**未定义：`@rev/<sha>` 读的是 git 对象，默认路由读的是工作树，两者在恢复后是否仍一致？

**建议：** 明确「恢复」的语义是「把旧版本内容作为新提交放到最前」→ 工作树 = 该版本内容，因此默认路由与 `@rev/<新 sha>` 应完全一致；并在测试中加一条断言。

**问题 5.3.5（边界场景）** `restore: <短 sha>` 提交说明用短 sha，但短 sha 在同一仓库内可能歧义（虽然概率低）。另外恢复操作本身是否也触发一次自动快照（会不会产生嵌套提交）？

**建议：** 用完整 sha 或 `shortHash + 提交时间戳`；明确恢复操作不触发额外的 `agent_settled` 快照（它由钩子驱动，恢复是渲染层发起的）。

### §5.4 品牌、设计系统、交付、自家产品改版（M3）

**问题 5.4.1（技术方案）** 品牌抽取与设计系统导入都依赖新增的能力，但**四个导入来源的错误契约未定义**：Figma Tokens JSON 结构不对、CSS 变量文件无 `:root`、DESIGN.md 格式不符、包缺失——是抛错给模型（让它修参数）还是部分成功（给出「成功 N 组 token，失败 M 组」）？

**建议：** 定义统一的返回结构与失败语义（建议部分成功 + 明确列出失败原因，便于模型自纠）。

**问题 5.4.2（产品改版 / 边界）** `product_source` 经 `codeRetrieval.call` 查询 CodeGraph，但 CodeGraph 需要**先索引**才可用（仓库 AGENTS.md 提到 `code-retrieval` 每轮给 hint 说索引是否存在）。挂入的产品仓库若未索引，`product_source search` 返回空，模型会误判为「没有这个组件」。

**建议：** 明确首次调用时若索引不存在的行为：返回明确错误「CodeGraph 未索引，请先建立索引」而非空结果。§8.4 的文件清单里也要体现这一点。

**问题 5.4.3（完整性）** 定稿后「用户在产品仓库新开普通编码会话，附上 `handoff/`」——这是一个**跨会话交付**动作，但规格没定义任何产品侧的支持（是让用户手动复制路径？还是 `handoff/` 提供一个「复制实现提示词」按钮？）。D15 说改动「实现交给普通编码会话」，但接口是断裂的。

**建议：** 至少定义 `handoff/IMPLEMENT.md`（面向编码会话的实现指引）或导出面板上的「复制实现提示」动作，否则 D15 的闭环不成立。

### §5.5 媒体、密钥、动效（M4）

**问题 5.5.1（完整性 / 验收不可执行）** M4 验收第 1 条承诺「图像：OpenAI 兼容、至少 2 家其它服务商；视频：至少 2 家；音频：至少 2 家」，但正文与矩阵**都没有列出具体服务商名单**与各自能力（谁能出图/视频/音频）。这会让 M4 的范围在开工时重新争论，也让「至少 2 家」无法排期。

**建议：** 列出候选名单与各自能力矩阵（哪怕标注「以密钥可获取性为准」）。注意这与第 12 节「无待定」的自检冲突——承认它是待定，比假装写死了更诚实。

**问题 5.5.2（技术方案）** `safeStorage` 在 `electron-agent/electron/` 下**无任何现有使用先例**（已核实）。这意味着要新引入一条加密存储路径，且 `safeStorage.isEncryptionAvailable()` 在 Linux（无 keyring）上常返回 false。规格说「为假时拒绝保存并在设置页提示」——Linux 用户将完全无法配置媒体密钥。

**建议：** 明确 Linux 上的行为与提示文案；并说明已有的「复用模型设置里服务商密钥」路径是否覆盖 Linux 场景（那一条不依赖 safeStorage）。

**问题 5.5.3（技术方案）** ffmpeg 下载「校验 sha256，不符则删除并报错」。但**哈希值从哪来**没写（硬编码在代码里？随版本更新怎么办？镜像地址的哈希是否与官方一致？）。这是可维护性问题，也会导致升级 ffmpeg 版本时必然失败。

**建议：** 明确哈希的存放位置（常量表，含 platform → {url, sha256}），并说明镜像必须提供与官方一致的二进制（否则哈希校验必然失败——这条要写进设置页的说明文字）。

**问题 5.5.4（完整性）** `speak`（tts）在设计会话外继续存在，`generate_audio` 在设计会话内使用 → 两套音频路径长期并存。规格没说后续是否收敛。

**建议：** 在第 11 节补一条后续建议（是否在 M5 后统一到 `media`）。

### §5.6 记忆、评审（M5）

**问题 5.6.1（P0 / 实现路径空白）** 「收尾核对：可机械检查的规则直接比对产出计算样式」——但**没有任何 RPC 能读取产出页面的计算样式**。`design.render` 只收集 console 错误；`design.inspectUrl`（读取外部网址计算样式）要到 M3 才加，且是给 `extract_brand` 用的。要「比对产出计算样式」需要一个新 RPC（如 `design.inspectArtifact`），而 §8.6 的文件清单**没有列出 `designRenderer.ts` / `runtime.ts` 的对应改动**。文件清单与需求不匹配。

**建议：** 在 §8.6 补：新增 RPC `design.inspectArtifact`（离屏加载产出 + 注入计算样式采集脚本），改动 `designRenderer.ts`、`main.ts`、`runtime.ts`。否则 M5 验收第 2 条（机械核对退回）无法成立。

**问题 5.6.2（P0 / 「定稿前自动评审」无实现路径）** 「设置里开『定稿前自动评审』，此时 `finalize_design` 执行前先评审」。`finalize_design` 是一个**工具**，规格没说怎么在工具执行「前」插入评审：在 `tool_call` 钩子里拦截 `finalize_design` 并先跑评审？（那评审期间工具如何挂起、结果如何回灌、会不会与完成钩子的 3 次退回叠加？）还是在 `agent_before_settle` 里检测本轮是否定稿？（那「执行前」的语义就变了。）

**建议：** 明确机制。推荐：在 `tool_call` 拦截 `finalize_design` → 先跑评审 → 把评审结果作为**追加文本**回灌到 `event.input`（或直接放行并在工具内部先评审）。同时明确评审失败/超时时的行为（放行还是阻断定稿），以及评审的退回是否计入 §5.2 的「最多 3 次」上限。

**问题 5.6.3（技术方案）** 「四个子代理…子代理工具限于只读工具与 `render_screenshot`」。但 `setActiveTools` 是**会话级**的（`types.d.ts:1074`），扩展如何为 `spawn_agent` 的子代理单独限制工具集？规格没说机制。另外四路并发 `render_screenshot` 打在「池上限 2」上 → 排队，评审延迟未评估。

**建议：** 明确子代理工具限制的实现手段（spawn 参数？子代理内自行 `setActiveTools`？），并评估并发截图对池的压力（建议评审串行或复用同一截图结果）。

### §6 对齐矩阵

**评价：** 38 行矩阵是本规格最有价值的部分之一，工作量与里程碑列清晰，与第 5、8 节的一致性我抽查未发现矛盾。`tempHtmlService`（#20）与 `gitService`（#23）两条「harness 已有」均已核实为真。

**问题 6.1（风险量化）** 按矩阵粗估（S=1.5、M=5、L=11 人日中位）：S × 10 + M × 19 + L × 7 ≈ **15 + 95 + 77 ≈ 190 人日**（规格说明不含评审与打包冒烟）。这是一个约 9 人月的工程，但**没有总人日、没有时间线、没有并行/串行假设**。而且 M1 内部已含一个 L（#8 幻灯片 deck framework）加 6 个 M，排在 M0 之后紧接着交付，排期风险高。

**建议：** 补一行合计与里程碑时间线，并复核 M1 是否过载（考虑把 #8 幻灯片拆到 M1.5 或延到 M2）。

**问题 6.2（一致性）** #17「CTA 层级检查」标 M2，但 §5.2 的自检闭环（M1）与 §8.2 的文件清单都没有它；§5.3（M2）也没提它。这是一个**矩阵有、设计与文件清单没有**的孤儿条目。

**建议：** 把 #17 加进 §5.3 或 §8.3，或调整矩阵的里程碑列。

### §7 里程碑、交付物与验收标准

**问题 7.1（M0 验收第 3 条不可靠）** 「模型写入 `artifacts/index.html` 后，`design` 标签页 1 秒内显示新内容」。链路是 `fs.watch` + 200ms 去抖 + SSE 推送 + webview 重载，冷启动或含大图时 1 秒未必成立，且这条无法自动化。

**建议：** 改为「文件写入后 2 秒内完成刷新（热重载场景，不含 webview 首次挂载）」，并说明验收方式（手动或带容差的集成测试）。

**问题 7.2（M1 验收第 1 条无法复现）** 「用 faux provider 驱动的冒烟会话中，写入含 P0 问题的 HTML」——faux provider 是脚本化的，需要预先准备会产出坏 HTML 的 fixture。§9 只说「用 faux provider 驱动」，没说 fixture 从哪来（`lint/fixtures/*.html` 是 lint 单测用的，不是冒烟用的）。

**建议：** 明确冒烟脚本路径与 fixture 内容（含「修复后版本」），否则这条验收每次都要重新造。

**问题 7.3（M4 验收第 2 条）** 「worker 进程环境变量与 runtime config 中查不到该密钥」——这是安全断言，但没说怎么测（读 `/proc/self/environ`？扫 runtime config 文件？）。

**建议：** 给出具体检查手段，否则容易写成一句空断言。

### §8 文件级改动清单

**评价：** 细到「+ `.test.ts`」的粒度，且区分新建/修改，是很好的工程习惯。

**问题 8.1** 缺 `designRenderer` / `runtime.ts` 的 `design.inspectArtifact`（见 5.6.1）。
**问题 8.2** 缺 `git` 可用性检测与降级路径的文件（见 5.1.1）。
**问题 8.3** 缺设计预览 webview 的 preload / partition 相关文件（见 5.1.2）。
**问题 8.4** 缺产出注册表（`.design/project.json` 的 `artifacts` 字段）相关改动（见 5.2.1）。
**问题 8.5** `extensions/agent-mode/questions.ts` 的类型变更范围未写（见 3.4）。
**问题 8.6** 白名单中的 `search`（batch-tools 提供）等工具名建议逐个核对实际注册名——我在 `extensions/*/index.ts` 的 `name:` 扫描中未匹配到 `search`，M0 落地前需确认它确实以 `search` 注册（否则会被 `activeToolsFor` 的交集静默滤掉）。

### §9 测试策略

**评价：** 分层清楚（工具元数据 / 扩展单测 / 主进程 vitest / 渲染层 jsdom / 端到端冒烟），且正确引用了 `extensions/prompt-metadata.test.ts` 这一仓库约定（AGENTS.md 也要求每个工具必须有 `promptSnippet`）。

**问题 9.1（完整性）** 未覆盖的测试点：① git 不可用降级（5.1.1）；② 大文件入库前 `git rm --cached`（4.4）；③ sections 渲染后的 XML 标签闭合（3.3）；④ 首轮竞态下标记缺失（4.1）；⑤ 预览 token 校验与 SSE 端点鉴权（5.1.3）；⑥ 控制台错误区分网络类与脚本类（5.2.5）；⑦ 导出独立窗口不饿死截图池（5.3.1）。

**问题 9.2（可行性）** 「截图、导出、MP4 的集成测试：在 `main` 项目下用真实离屏窗口跑」——仓库中**尚无 offscreen / `printToPDF` / `capturePage` 的先例**（已核实），且 §10 已承认「无显示环境（CI）不可用」。这条集成测试在无头 CI 上必然跳过，等于没有门禁。

**建议：** 明确这类测试标记（如 `describe.skipIf(!hasDisplay)`），并在 §10 风险里补一句「导出/截图的真实渲染在 CI 无门禁，依赖发布前打包冒烟」。

### §10 风险

**评价：** 许可证、提示长度、ffmpeg 下载、离屏渲染、工具泄漏、仓库同步、Electron 版本下限——覆盖了主要风险，质量好。

**问题 10.1（缺失）** 建议新增以下行：

| 风险 | 应对 |
|---|---|
| 系统未安装 git（Windows 常见） | 见 5.1.1：检测 + 文件系统快照降级 |
| 设计预览 webview 被注入应用 preload | 见 5.1.2：独立 partition / 不注入应用 preload |
| MCP 工具绕过设计白名单 | 见 3.2：默认不启用或显式声明授权 |
| MP4 逐帧导出饿死截图池 / 帧数爆炸 | 见 5.3.1：独立窗口 + 帧数上限 |
| 外链 CDN 导致控制台错误误报 | 见 5.2.5：区分网络类与脚本类 |
| safeStorage 在 Linux 不可用 | 见 5.5.2 |
| 项目规模约 190 人日，M1 排期过载 | 见 6.1 |

**问题 10.2** 「仓库同步：本地 master 比 GitHub 超前 666 个提交」——这条是实施前置条件而非技术风险，建议在实施计划里作为开工前检查项列出（我在本次审查中未核实该数字）。

### §11 未决问题与后续建议

**评价：** 诚实地列出了 HyperFrames 运行时许可证、fable-behavior 裁剪、auth.json 迁移三项，好。

**问题 11.1** 建议追加：① 媒体服务商候选名单（5.5.1）；② `speak` 与 `generate_audio` 是否收敛（5.5.4）；③ 跨会话交付（设计 → 编码会话）的产品侧支持（5.4.3）；④ 预览 webview preload 策略（5.1.2）——该项我倾向认为应在开工前定，而非列为未决。

### §12 规格自检

**问题 12.1（自检不成立）** 第 1 条「无『待定 / TODO』占位；端口、超时、退回次数、提示上限、大文件阈值、轮询间隔、视口预设均已写死」——**「无待定」在接口维度上不成立**：

- 11 个新工具中，只有 `render_screenshot` 的参数接近完整，其余均未给出 schema（见第四节）；
- `export_artifact` 的 `options` 未展开；
- `design_catalog` 的 `search` 查询参数、`read` 的 id 格式与返回结构未定义；
- `import_design_system` 四种来源共用一个 schema 还是分 action 未定；
- `product_source` 的 `node` action 参数未定；
- `extract_brand` 只有 `url` 一个参数，无超时/视口/是否整页截图选项（但正文说「另截整页图」）；
- M4 服务商名单未定。

「数值都写死」与「接口都定义完」是两件事。建议把第 1 条改为「运行参数已写死；工具 schema 在实现计划中补齐」，或直接在规格里补 schema。

**问题 12.2** 第 2 条说 D1–D17 与第 5、6、8 节一致——抽查一致，但 #17（CTA 层级检查）在设计与文件清单中缺失（6.2），`design.inspectArtifact` 在文件清单中缺失（5.6.1），建议同步。

---

## 二、实施前必须改（P0）

按「不改就会卡住哪个里程碑」排序：

| # | 问题 | 卡住 | 建议改法 |
|---|---|---|---|
| P0-1 | `git` 依赖无降级路径（5.1.1） | M0 验收 1 | 检测 git 可用性；不可用时降级为文件系统快照，或创建时阻断并提示安装。同步改 §5.3 版本列表/恢复与 §9 测试 |
| P0-2 | 设计预览 webview 会被注入应用 preload（5.1.2） | M0 预览，且是安全面 | 明确独立 partition + 是否注入应用 preload；写进 D4 与 §10 |
| P0-3 | `ask_user` 的 `options` / `allowMultiple` 是必填，与 color/file 字段冲突（3.4） | M1 澄清表单 | 两字段改可选；定义 `field` 类型联合；补旧草稿兼容与 `file` 落点恢复 |
| P0-4 | 「产出」概念与注册表缺失（5.2.1） | M1 完成钩子 / lint 触发 | `project.json` 增加 `artifacts: [{id, path, kind, updatedAt}]`，由 `tool_result` 维护；预览切换、导出、版本统一读它 |
| P0-5 | 「定稿前自动评审」无实现路径（5.6.2） | M5 | 明确在 `tool_call` 拦截 `finalize_design`；定义评审失败/超时行为与是否计入 3 次退回 |
| P0-6 | 「机械核对计算样式」缺 RPC（5.6.1） | M5 验收 2 | 新增 `design.inspectArtifact`，补 `designRenderer` / `main.ts` / `runtime.ts` 改动 |

次级但建议一并处理（P1）：首轮竞态与幂等（4.1、4.2）、大文件 `git rm --cached` 顺序（4.4）、MCP 绕过白名单（3.2）、MP4 独立窗口与帧数上限（5.3.1）、PDF 字体就绪与幻灯片分页手段（5.3.2）、控制台错误区分网络类（5.2.5）、`.htm` 与外部资源的 lint 触发（5.2.4）、M1 工作量过载（6.1）、#17 孤儿条目（6.2）。

---

## 三、建议补充的边界场景清单

规格已覆盖端口占用、截图超时、页面加载失败、资产加载失败、条目缺失五类。建议再补：

1. **首轮竞态**：标记写入完成前用户已发消息（4.1）。
2. **重复写标记**：重试 / 多窗口 / 会话重开（4.2）。
3. **会话 fork / 树导航**：设计标记是否继承（4.3）。
4. **设计会话切换 workspace**：写入全被拦（4.3）。
5. **普通会话打开设计项目目录**：可破坏 git 历史（4.3）。
6. **应用重启**：预览 token / 端口变化，标签页如何重新取址（5.1.3）。
7. **git 不可用**（5.1.1）。
8. **safeStorage 不可用**（Linux）（5.5.2）。
9. **外链 CDN 离线**：控制台错误误报导致必然退回 3 次（5.2.5）。
10. **素材先入库后标记大文件**：历史已被污染（4.4）。
11. **一轮产出过多**：完成钩子截图串行 + 退回 3 次的耗时（5.1.4）。
12. **超大 MP4**：帧数/磁盘/内存（5.3.1）。
13. **CodeGraph 未索引**：`product_source search` 返回空导致模型误判（5.4.2）。
14. **导入源格式错误**：部分成功还是整体失败（5.4.1）。
15. **`data-od-id` 重复或元素由脚本生成**：改文字定位失败的提示路径（§5.3 已写「提示改用批注」✅，建议纳入测试）。
16. **ffmpeg 镜像哈希与官方不一致**：必然校验失败（5.5.3）。
17. **视频生成中途应用退出**：轮询任务与已扣费的处理（建议补：任务 id 持久化到 `.design/media-tasks.json`，重启后可续查）。

---

## 四、工具接口待补清单（建议以 TypeBox schema 草案形式补进规格）

| 工具 | 现状 | 需补 |
|---|---|---|
| `render_screenshot` | 参数较完整（path/viewport/fullPage/selector/waitMs） | `details` 结构；超时错误的返回形状 |
| `design_catalog` | action/kind 有，参数无 | `search` 的 query / 产出类型 / 上限；`read` 的 id 格式与返回结构（files + content + 大小阈值） |
| `lint_artifact` | 只有 `path` | 返回结构（P0/P1/P2 列表、每条的 file/line/rule/message/可修复否） |
| `export_artifact` | `{path, format, options}` | `options` 按 format 展开（PDF 的页边距/横竖、PNG 的 fullPage、MP4 的 fps/时长/音频、PPTX 的尺寸）；进度上报 |
| `extract_brand` | 只有 `url` | 超时、视口、是否整页截图、离线时的行为 |
| `import_design_system` | 四种来源未分 action | 每来源的参数与返回（成功/部分失败）契约 |
| `finalize_design` | 无参数说明 | 是否触发评审、是否自动导出 handoff |
| `product_source` | `search`/`node`/`read` | `node` 的参数（符号名？文件？）；索引缺失时的返回 |
| `generate_image` | 沿用现有 | 落盘路径分流（设计会话 vs 其它）；新增 `provider`/`model` 的取值来源 |
| `generate_video` | 无 | prompt/时长/比例/provider/model；费用确认的表单字段与取消语义 |
| `generate_audio` | `kind` 有 | speech/music/sfx 各自参数（文本/时长/风格） |

同时建议统一约定：
- **`details` 结构**（渲染层消费，尤其 `render_screenshot` 的产出关联、`export_artifact` 的路径）；
- **错误契约**：工具层（给模型的文字错误）与 IPC 层（`design_create_project` 等 5 个命令的返回形状，`register.test.ts` / `commandCoverage.test.ts` 会覆盖）分开定义；
- **`promptSnippet` / `promptGuidelines`**：AGENTS.md 要求每个注册工具必须有 `promptSnippet`，且 `promptGuidelines` 每条必须写出工具名（禁止写 `this tool`）。§9 已提到 `prompt-metadata.test.ts`，建议在 §8 里也提醒一句，避免实现时漏。

---

## 五、结论

规格的**架构决策与对齐分析是可靠的**——我核实过的 15 项 SDK/仓库假设全部成立，D1–D17 与三节内容的一致性也经得起抽查。主要问题集中在两处：**一是「接口定义清晰度」这一维度明显弱于其余维度**（11 个工具的 schema 与返回契约基本空白，第 12 节的自检在这一维度不成立）；**二是若干跨节依赖没有闭环**（git 降级、产出注册表、预览 preload、评审插入点、计算样式 RPC）。

建议：**有条件批准**——先修 P0-1 至 P0-6，补齐第四节的接口契约与第三节的边界场景，再拆分 M0–M5 实现计划。P1 项可在计划拆分时一并处理。
