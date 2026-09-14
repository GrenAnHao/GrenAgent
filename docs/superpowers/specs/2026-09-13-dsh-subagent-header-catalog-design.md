# DSH 子代理第三期：页头目录与子会话编辑器

- 日期：2026-09-13
- 状态：已落地（2026-09-14 核实）
- 复核：2026-09-13 对照 `extensions/multi-agent` 与 Electron 前端现状做过一轮修订（见 §9 附录）
- 主题：对齐 DSH 页头谱系目录：父会话自有目录事实、token / 耗时、点开子会话；one-shot 只读，continuable 可续聊。
- 依赖：[规格 1](./2026-09-13-dsh-subagent-session-child-design.md)（会话绑定）、[规格 2](./2026-09-13-dsh-subagent-continuable-notice-design.md)（Activation / 人类投递）
- 后继：[规格 4：fork 种子](./2026-09-13-dsh-subagent-fork-seed-design.md)（目录必须忽略种子 / 用户 fork 拷进来的事实）
- 关联：`electron-agent/src/features/layout/MainColumnHeader.tsx`、`electron-agent/src/features/subagents/SubAgentMenuButton.tsx`、`electron-agent/src/features/panels/SubAgentConversation.tsx`

---

## 1. 目标与范围

规格 1 只能从工具卡片或右坞打开子会话。规格 2 让可续聊子级在结算后仍能接收消息，但人类没有目录、也没有往子会话打字的地方。DSH 把发现放在**父会话页头**，权威是父 JSONL 里的 `subagent/catalog` 事实，不是扫全库、也不是 registry.db。

本期做：

1. 父会话写下并折出直接子级目录。
2. Electron 主列页头出现目录开关，树里能看到 label、mode、活性、token、耗时。
3. 点一行，在主列打开子会话覆层（不替换 `WorkspaceHandle` 里的父 Session）。
4. one-shot 覆层只读；continuable 覆层带输入框，投递走规格 2 inbox。

**成功标准：**

1. 父会话成功创建一个 embedded 子级后，不刷新窗口也能在页头目录看到这一行。
2. 用户把父会话 rewind / fork 成新文件后，新分支**不**列出旧分支的子级。
3. 点 continuable 行能打字；消息进入该子 JSONL，不出现在父主 store。
4. 点 one-shot 行没有输入框。
5. 现有 `SubAgentMenuButton`（工作区 registry 托盘）仍在，职责不改。

**范围**：sidecar 目录写入 + Electron 页头 / 覆层。CLI 无页头。Tauri 不做。不把子会话挂进左侧会话列表。

---

## 2. 方案取舍（已锁定）

| 方案 | 做法 | 结论 |
|------|------|------|
| A. 父 JSONL 自有目录事实 + 页头 + 主列覆层（**采用**） | 权威在父日志；打开子级不换父 handle | 对齐 DSH 发现，兼容现有 WorkspaceHandle |
| B. 扫 `~/.pi/agent/sessions` 里 `parentSession === 当前` | 实现快 | DSH 明确抛弃过：贵、和 fork 隔离冲突 |
| C. 只扩展 `SubAgentMenuButton` 读 registry | 零新存储 | registry 是工作区级、会淡出，不是父会话谱系 |
| D. 点目录行把 `WorkspaceHandle` 切到子 Session | 最像 DSH 主视图 | 父 Activation / Goal / 输入队列会一起被拆掉 |

C 留下当「工作区正在跑谁」的托盘。A 是会话谱系。两者并存。

---

## 3. 目录权威

### 3.1 事件

父会话用扩展侧 API `pi.appendEntry("subagent_catalog", fact)` 写一条 `custom`（**不进**模型）：

```ts
interface SubagentCatalogFact {
  version: 0;
  childId: string;          // sa-…
  sessionPath: string;
  childCreatedAt: number;   // ms
  mode: "one-shot" | "continuable";
  label: string;            // continuable 必填；one-shot 用任务首行，可空则写 "(untitled)"
}
```

注意 API 名：扩展侧是 `pi.appendEntry(customType, data)`；`sessionManager.appendCustomEntry` 只在**子会话**里写 `subagent_meta` 时用。两者别混。

写入时机（对齐 DSH，只记成功事实）：

- one-shot：`createEmbeddedChildSession` 成功且即将把结果交回父工具之前
- continuable：规格 2 首次 inbox 接受之后、返回 `agentId` 之前

启动失败、inbox 未接受、目录写入失败：

- continuable：整段创建失败，拆除 Activation，不留「有目录无孩子」或「有孩子无目录」
- one-shot：工具结果按规格 1 失败返回；已有的子 JSONL 可留作调试，但父目录没有这一行

不写补偿删除事件。子级被 `cancel` / 自然结算后，目录行仍在（DSH 也不删）。活性靠现场采样，不靠改旧事实。

并行 `tasks` / `chain`：每个成功的 embedded 单元各写一行，`label` 用该单元任务首行。子进程回退单元**不写**目录（没有可绑的本地 Session）。

### 3.2 折叠

```ts
interface SubagentCatalogEntry {
  id: string;
  sessionPath: string;
  createdAt: number;
  mode: "one-shot" | "continuable";
  label: string;
}

interface SubagentCatalogView {
  entries: SubagentCatalogEntry[]; // 父目录事件顺序，不是 childCreatedAt 排序
}
```

`session_start` 与每次写入后，扫父 JSONL 折一次：

1. 找到本文件里的 `subagent_catalog_base`（§3.3）。没有则 `inheritedFrom = 文件起点`。
2. **只沿当前 leaf 路径扫**：用 `SessionManager.open(parentPath).buildContextEntries()`，不是 `getEntries()`。`getEntries()` 返回的是**全文件物理顺序**，rewind / fork 之后被放弃的分支上的目录事实也会混进来；`buildContextEntries()` 走 leaf→root（且已处理 compaction），才对得上「成功标准 2：rewind 后不列旧分支子级」。两把切刀叠用：leaf 路径 **且** `subagent_catalog_base` 之后。
3. 只收 type 为 `custom` / `custom_message` 且 `customType` 为 `subagent_catalog` 的条目。
4. `version !== 0` 或缺 `childId` / `sessionPath` / `mode` 的自身事实：这条标 `diagnostic`（`corrupt`），不让整份目录失败。这与 DSH「无效 required fact 使 projection 恢复失败」不同——GrenAgent 没有 projection registry，单条损坏不该让页头空白。
5. 不读子 JSONL 来「发现」孩子；子文件只用于活性、token、耗时、打开覆层。
6. 折叠只用 `buildContextEntries()` 的结果，只读，不 `branch()`、不改写 leaf。

**compaction 的连带后果（接受）**：父会话 compaction 后，被摘要掉的旧 `subagent_catalog` 事实不再出现在 leaf 上下文里，页头行数会变少（文件里的行没丢，只是不在当前上下文）。目录语义定义为「当前上下文里的子级谱系」，不是「本会话历史全量」。不为此给目录事实加 compaction 豁免——那是规格外的复杂度。

不引入 `dsh-chunked-list`。直接子级数量跟现有 `SUBAGENT_MAX_PER_SESSION` 同级，线性扫足够。

### 3.3 fork / 种子隔离（本期写机制，规格 4 复用）

用户 rewind 出的新父文件会拷贝旧的 `subagent_catalog` 行。fork 种子也会把父日志前缀拷进子文件。这些行不能变成「我的孩子」。

统一切刀：`customType: "subagent_catalog_base"`

```ts
{ version: 0, reason: "user-fork" | "subagent-seed" }
```

规则：该条目**之前**（含拷贝进来的目录事实）一律忽略；之后的才是本 Session 的目录。

写入：

- 用户 fork / rewind：`session_before_fork` 之后、新会话第一条可写时机，若拷贝集里已有 `subagent_catalog`，就写一条 `subagent_catalog_base`（`reason: "user-fork"`）。拷贝集里没有目录事实则不写，避免空标记。
- 规格 4 种子：先写种子消息，**一律**写 `subagent_catalog_base`（`reason: "subagent-seed"`），再跑子任务。种子路径必须防拷漏，不跟用户 fork 共用「没有就不写」。

### 3.4 现场采样（打开目录时）

每行补：

```ts
type CatalogActivity = "running" | "idle" | "ready" | "settled" | "unavailable";

interface CatalogRowView extends SubagentCatalogEntry {
  activity: CatalogActivity;
  hasChildren: boolean;
  tokens?: number;
  durationMs?: number;
  diagnostic?: "corrupt" | "unavailable";
}
```

| activity | 含义 |
|----------|------|
| `running` | 该 `sessionPath` 有驻留 Activation，且子 Session 非 idle |
| `idle` | 有驻留 Activation，但 `waitForIdle` 已满足（interrupt 之后、下一封信之前） |
| `ready` | 无 Activation，JSONL 在，`mode === "continuable"`，未 `tornDown`（可冷恢复） |
| `settled` | 无 Activation，JSONL 在，但不可再投递（`mode === "one-shot"`，或已 `tornDown`） |
| `unavailable` | 文件没了，或打开/读 usage 抛错 |

原表格把「one-shot 已结算、文件还在」归到 `unavailable`，和「读不到」混成一档——这行其实能打开覆层只读看内容，不该显示成不可用，所以拆出 `settled`。

`hasChildren`：打开该子 JSONL，看它自己折叠后的目录是否非空。失败则 `false`，不递归扫孙文件。

`tokens`：子会话 usage 四段之和（uncachedInput + output + cacheRead + cacheWrite）。没有 usage 事件就省略，不写 0 装成「没花钱」。

`durationMs`：从子会话第一条用户消息时间戳到最后一条助手 / 工具事件时间戳；驻留且 `running` 时终点用 `Date.now()`。没有时间戳就省略。

**规格 4 落地后必须切掉种子**：fork 子级的 `session.messages` 前 `inheritedEventCount` 条是父的旧对话，它们的 usage / 时间戳属于父会话。采样时先读子 `subagent_meta.inheritedEventCount`（缺省 0），只对 `messages.slice(inheritedEventCount)` 统计 token 与耗时；`hasChildren` 的折叠不受影响（走 §3.3 的 base 切刀）。不切的话，一个 fork 子级会把父会话的全部 token 记在自己头上。

采样在点开目录或点刷新时做。不设后台轮询整棵树。目录开着且有 `running` 行时，每 2 秒只重采这些行的 activity / tokens / duration。

---

## 4. Electron UI

### 4.1 页头开关

放在 `MainColumnHeader` 左侧、`WorkspaceTabs` 与 `PlanModeBadge` 之间（两者都是该文件或 `../workspace` 里的组件，`PlanModeBadge` 是 `MainColumnHeader.tsx` 内的本地组件，位置描述成立）。不要塞进右侧 `SubAgentMenuButton`。

- 当前主会话目录 `entries.length === 0`：不渲染开关（与「没有 Goal 就不画 Goal 条」相同）。
- 有条目：图标按钮，`data-testid="subagent-header-catalog"`。有 `running` 时角标为运行数。
- 点开：portal 下拉，宽度 360px，最高 `min(60vh, 520px)`。
- 下拉头：`子代理 · N` + 刷新。
- 行：状态点、`label`（单行省略）、右侧 `mode` 小字、`tokens`、`duration`。
- `hasChildren`：行左侧展开三角；展开后缩进 16px 渲染该子的目录（再采样一层）。默认不预拉整棵树。
- `diagnostic`：禁用点击，文案 `无法读取` / `记录损坏`。
- 当前覆层正在看的 `childId` 高亮。
- 键盘：下拉 `role="tree"`，可箭头移动、Enter 打开、Esc 关闭。

时间格式：`< 1 min` 用秒；`< 1 h` 用 `m:ss`；更长用 `h:mm:ss`。token：`< 1000` 原样，否则一位小数 + `k` / `M`。

### 4.2 打开：主列覆层，不切 WorkspaceHandle

父 `AgentSession` 必须留在 `WorkspaceHandle` 里，否则规格 2 的 parent host、Goal 条、父输入队列会断。

```
MainChatColumn                       // src/App.tsx 内的本地组件，没有同名文件
  ├─ MainColumnHeader（目录开关仍对父会话）
  ├─ 父 ChatView（覆层打开时停在下面，不卸载）
  └─ ChildSessionOverlay（绝对铺满主列内容区，不含页头）
```

`MainChatColumn` 的内容区外层已经是 `position: relative` 的 `Flexbox`，覆层可以直接绝对定位铺满，不必改 `App.tsx` 的布局层级。

覆层：

- 顶条：`← 返回 <父标题>`、子 `label`、mode、activity、只读或可续聊标记
- 中间：复用规格 1 的子会话绑定（`sessionPath` + `source: "subagent"` 事件），**不要**再走 registry transcript
- 底栏：见 §4.3
- `data-testid="subagent-child-overlay"`
- 打开覆层不改左侧会话选中项、不改 `WorkspaceHandle.session`

从工具卡片 / `SubAgentMenuButton` 打开右坞的路径保留。目录打开覆层；右坞打开 dock。两处可以同时看同一个 `sessionPath`，绑定同一条事件流。

返回：关覆层，父对话从离开时的滚动位置继续。不把覆层做成可堆叠的一串（从子目录再点孙：覆层换成孙，顶条返回仍回父，不回中间子。要看中间子再从目录点一次）。这避免 WorkspaceHandle 式的会话栈。

### 4.3 只读 vs 可续聊

| 条件 | 底栏 |
|------|------|
| `mode === "one-shot"` | 无输入框，一条 `此子代理只读` |
| `mode === "continuable"` 且未 `tornDown` | 输入框 |
| `tornDown` / 文件缺失 | 无输入框，一条 `无法继续` |

输入框对齐主对话 `SendArea` 的既有语义，不另做 Queue/Steer 开关：

- 子级 `running` → 按钮「引导」，IPC `delivery: "steer"`
- 否则 → 按钮「发送」，IPC `delivery: "followUp"`（`ready` 时由规格 2 冷恢复）

IPC：

```
subagent_prompt: { workspace, sessionPath, message, delivery: "followUp" | "steer" }
subagent_interrupt: { workspace, sessionPath }
```

主进程找到 Activation 或走冷恢复，再调规格 2 inbox。权限：`sessionPath` 必须落在**当前父会话折叠出的目录白名单**里（本次 `foldCatalog` 的 entries + 已展开的后代），主进程用 `catalog(parentSessionPath)` 的结果现算一次，不缓存、不信渲染层传来的任意路径。工作区内但不在目录里的路径一律拒绝——否则任意 JSONL 都能被当子会话投消息。

覆层顶条在 `running` 时提供停止：调 `subagent_interrupt`（keep inbox），不是 `spawn_agent` `cancel`。

图片：本期只发文本。子模型若以后要图，另开规格。不要在 IPC 上接收工作区外的文件路径。

### 4.4 与 `SubAgentMenuButton` 的边界

| | 页头目录 | Bot 菜单 |
|--|----------|----------|
| 权威 | 父 JSONL 目录事实 | `.pi/subagents/registry.db` |
| 范围 | 当前父会话谱系 | 整个工作区 |
| 淡出 | 无 | 终态 5 分钟 |
| 打开 | 主列覆层 | 右坞 |
| 子进程 / 无 sessionPath | 不出现 | 出现 |

不要在本期删 Bot 菜单，也不要让目录去读 registry 凑行。

---

## 5. sidecar / IPC

| 文件 | 职责 |
|------|------|
| `extensions/multi-agent/catalog.ts` | `establishCatalogChild`、`foldCatalog`、`subagent_catalog_base` |
| `extensions/multi-agent/index.ts` / Activation 启动点 | 成功创建后调用 `establishCatalogChild` + `emitCatalogChanged` |
| `extensions/multi-agent/catalog-events.ts`（新增） | `emitCatalogChanged(meta)` + `registerCatalogChangeSink`，与 `embedded-events.ts` 同构 |
| `electron-agent/electron/agent/workspaceHandle.ts` | `start()` 注册 catalog sink 并转成 `pi://event`；`dispose()` 注销 |
| `electron-agent/electron/app/subagentService.ts` | `catalog(parentSessionPath)`、`catalogRowSample(sessionPath)`、`prompt` / `interrupt`（`SessionManager.open` 只读用法照现有 `sessionMessages()` 抄） |
| `electron-agent/src/lib/pi.ts` | 对应 invoke（照现有 `subagentGetSessionMessages` 写） |
| `electron-agent/src/features/subagents/SubagentHeaderCatalog.tsx` | 页头开关 + 下拉 |
| `electron-agent/src/features/subagents/ChildSessionOverlay.tsx` | 覆层 + 输入框 |
| `electron-agent/src/features/panels/SubAgentConversation.tsx` | 抽出绑定 hook 给覆层复用；本身仍只读 |

父目录变更**不能**靠 `session.subscribe` 广播——扩展自己发的事件不进会话事件流。走 `catalog-events.ts` 的 host sink（和 `embedded-events.ts` 一样由 `WorkspaceHandle` 注册）：sidecar 在 `pi.appendEntry("subagent_catalog")` 后 `emitCatalogChanged({ sessionPath: 父路径 })`，`WorkspaceHandle` 转成 `pi://event`（`source: 'interactive'`，`type: "subagent_catalog_changed"`）。主 store 按 type 白名单收，忽略这条（不当聊天）。页头订阅后重折。不要轮询父 JSONL。

---

## 6. 错误与空态

- 父文件不可读：开关不出现
- 子文件采样失败：行保留，`activity: "unavailable"`，token / 耗时空
- `subagent_prompt` 对 one-shot：IPC 错，覆层不画输入框（双保险）
- 冷恢复失败：输入框上方一条错误，不关覆层
- 目录写入失败见 §3.1，不重试成第二条事实

---

## 7. 明确不做

- 子会话进入左侧会话列表
- 替换或删除 `SubAgentMenuButton`
- 切换 `WorkspaceHandle` 到子 Session
- DSH chunked-list / projection cache
- 目录分页、删除一行、改 label
- 人类选图、选 Queue/Steer 开关
- Tauri 页头
- 把目录事实送进模型上下文
- 嵌套 spawn（`hasChildren` 预留给规格 4 之后若放开嵌套；本期只有用户手动打开的子级再 spawn 被禁止，所以树深几乎为 1）

`hasChildren` 仍然实现：规格 4 的 fork 子级若以后再委派，机制已经在。本期树几乎总是一层。

---

## 8. 测试

**catalog.ts**

- 两次成功创建 → 折叠顺序 = 写入顺序，与 `childCreatedAt` 无关
- `subagent_catalog_base` 之前的事实消失
- **rewind / 分支场景**：leaf 路径外的分支上有一条 `subagent_catalog`，折叠后不出现（这条单测锁死 `buildContextEntries()` 而不是 `getEntries()`）
- 缺字段的事实 → 一条 `corrupt`，其余行仍在
- 失败启动不调用 `establishCatalogChild`
- one-shot 结算后行仍在，`activity === "settled"`，不是 `unavailable`

**Electron 页头**

- 空目录：没有 `subagent-header-catalog`
- 有行：开关出现；点开看到 label / mode
- `running` 角标
- 点行打开覆层，`WorkspaceHandle` 会话路径仍是父（单测断言 overlay store ≠ 替换主 store）
- 返回后父滚动位置不丢（测「覆层挂载期间父 ChatView 未卸载」）

**覆层**

- one-shot：没有 composer
- continuable + ready：有 composer；发送走 `subagent_prompt` `followUp`
- continuable + running：按钮文案「引导」，`delivery: "steer"`
- 事件 `source: "subagent"` 只进覆层，不进父 `createAgentStore`

**隔离**

- 模拟用户 fork：新文件含旧 catalog 行 + `subagent_catalog_base` → 折叠为空
- 规格 4 落地前用夹具写 `reason: "subagent-seed"`，同样为空

不测 DSH 浏览器时区、附件准入。

---

## 9. 附录：本次复核已确认的现状（2026-09-13）

| 项 | 结论 |
|----|------|
| 目录写入 API | 扩展侧 `pi.appendEntry("subagent_catalog", fact)`；不是 `appendCustomEntry` |
| 折叠数据源 | `SessionManager.open(path).buildContextEntries()`（leaf 路径 + compaction 感知）；`getEntries()` 会带进已放弃分支 |
| 已有只读读口 | `electron/app/subagentService.ts::sessionMessages(sessionPath)` 已是 `SessionManager.open` + `buildSessionContext()`，新增 `catalog` / `catalogRowSample` 照抄 |
| 渲染层 IPC | `src/lib/pi.ts` 已有 `subagentGetSessionMessages` 等 invoke，新增照抄 |
| 页头组件 | `src/features/layout/MainColumnHeader.tsx`；`left` 槽位目前是 `<WorkspaceTabs />` + `<PlanModeBadge />`（后者是同文件本地组件） |
| 主列容器 | `MainChatColumn` 定义在 `src/App.tsx`，内容区外层已 `position: relative` |
| 覆层可复用绑定 | `src/features/panels/subagentUtils.ts` 已有 `shouldBindChildSession` / `subAgentSessionPath` / `isEmbeddedChildEvent` |
| 子事件过滤 | `src/stores/agent.ts:179` 已忽略 `source === 'subagent'`；目录事件要新加 type 白名单 |
| 单会话子代理上限 | `SUBAGENT_MAX_PER_SESSION` 默认 6（`index.ts:344`），目录行数同级，线性扫足够 |
