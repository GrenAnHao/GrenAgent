# DSH 子代理第六期：子级模型路由（用户授权白名单 + 发现工具）

- 日期：2026-09-14
- 状态：已落地
- 主题：对齐 DSH「模型侧为子级选路由默认关闭、由用户白名单授权」的立场；开启后提供 `list_subagent_models` 发现工具与 `thinking_level` 参数。
- 依赖：[规格 1](./2026-09-13-dsh-subagent-session-child-design.md)（`pickSubagentModel`、embedded runner）
- 关联：`extensions/multi-agent/index.ts`、`extensions/multi-agent/embedded-runner.ts`、`extensions/multi-agent/runner.ts`、`electron-agent/src/features/settings/settingsSchema.ts`、`SettingField.tsx`、`ModelSelectField.tsx`
- DSH 参照：`.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md`、`2026-08-24-user-authorized-subagent-model-routes.md`、`packages/subagent/tool-subagent/src/list-models.ts`

---

## 1. 问题

现状（2026-09-14 核对）：

- `spawn_agent` 的 `model`（顶层、`tasks[].model`、`chain[].model`、inline `profile.model`）始终暴露，接受任意 `provider/id` 字符串；没有「允许模型自己选哪些路由」的授权面。
- 用户只有 `SUBAGENT_MODE` 三档（`inherit` / `custom` / `disabled`），决定的是**未显式指定时**的默认，管不住显式指定。
- 没有发现工具，模型不知道哪些路由可用。
- 子级没有思考档参数。

DSH：模型侧选路由默认关；用户在设置里勾精确路由白名单才开；开了才注册 `list_subagent_models`；显式路由必须落在白名单 ∩ 实时目录内；`reasoning_effort` 随路由一起校验。

## 2. 目标与成功标准

1. 默认状态下 `spawn_agent` schema 不含任何 `model` 字段、不注册 `list_subagent_models`；execute 收到 `model` / `thinking_level` 一律报错不启动。
2. 用户开启开关并勾选 ≥1 条路由后新建的会话：`spawn_agent` 暴露 `model` 与 `thinking_level`，`list_subagent_models` 可用；白名单外或不可用的路由报错不启动。
3. named agent 的 `model`、profile 别名 `cheap` / `strong`、`SUBAGENT_MODEL`、父模型（用户配置的默认）不受开关与白名单影响。
4. `thinking_level` 在 embedded 与子进程两条路径都生效。

**范围**：`extensions/multi-agent` 工具面 + 新发现工具 + 设置页两个键与一种新字段类型。

## 3. 已核实的现状

| 项 | 结论 |
|---|---|
| 发现数据源 | 扩展 `ctx.modelRegistry.getAvailable()`；模型元数据 `reasoning` 字段标是否支持思考档 |
| 思考档 | SDK `ThinkingLevel = off\|minimal\|low\|medium\|high\|xhigh\|max`；embedded 走 `createAgentSessionFromServices({ thinkingLevel })`，子进程走 CLI `--thinking <level>`（`cli/args.js:112`） |
| 工具注册时机 | 扩展 factory 在 `bindExtensions` 时跑一次，schema 之后不可改 → 设置改动只影响之后新建 / 重开的会话 |
| 模型选择顺序 | `pickSubagentModel`：显式 → named agent → profile → `SUBAGENT_MODEL` → 父模型（`index.ts:178`） |
| 设置字段类型 | `FieldType` 现有 `text\|password\|number\|boolean\|select\|model\|capability`；`model` 是单选 `ModelSelectField`（antd `Select`），无多选 |
| typebox 校验 | 未声明键不拒绝，schema 去掉字段后仍需 execute 侧兜底 |

## 4. 方案取舍（已锁定）

| 方案 | 做法 | 结论 |
|---|---|---|
| **1. 开关 + 白名单两键，factory 时决定工具面（采用）** | 两个配置键；factory 读一次决定 schema 与是否注册发现工具 | 改动集中；不动 JSONL |
| 2. 策略快照进父 JSONL（照 DSH） | session_start 写 `subagent_model_policy` | Pi 子级没有 `spawn_agent`，「子级继承策略」无意义；恢复旧会话时 schema 已按当前配置注册，快照与 schema 打架 |
| 3. 白名单塞 `SUBAGENT_MODEL` 逗号串 | 零新字段类型 | 手打 `provider/id`，UX 差；与「选定模型」单值语义混淆 |

## 5. 设计

### 5.1 设置（`electron-agent/src/features/settings/`）

「子代理 → 模型策略」分组末尾新增：

| 键 | 类型 | 默认 | 文案 |
|---|---|---|---|
| `SUBAGENT_MODEL_SELECTION` | `boolean` | 关 | 允许模型为子代理自选路由。开启后 `spawn_agent` 可显式指定模型，且只能选下方白名单。改动对之后新建的会话生效 |
| `SUBAGENT_MODEL_ALLOWLIST` | `model-list`（新） | `[]` | 可自选的路由白名单；`showWhen: { key: 'SUBAGENT_MODEL_SELECTION', equals: ['1'] }` |

`model-list` 字段：
- 存储：JSON 数组字符串 `["provider/id", …]`；解析失败当 `[]`。
- 组件 `ModelListField.tsx`：复用 `ModelSelectField` 的模型目录数据源，antd `Select mode="multiple"`。已存但不在当前目录的条目照常显示并标「不可用」，可移除，不自动删（对齐 DSH）。
- `SettingField.tsx` 加 `case 'model-list'`；`FieldType` 联合加 `'model-list'`。

有效条件：开关开 **且** 列表非空。UI 不强制；sidecar 侧同一判定（§5.2）。

与 `SUBAGENT_MODE` 正交：`disabled` 仍整体禁 spawn；`inherit` / `custom` 仍决定未显式指定时的默认；本开关只决定能不能显式指定。

### 5.2 工具面（`extensions/multi-agent/index.ts` factory）

新增 `extensions/multi-agent/model-selection.ts`：

```ts
export function readModelSelectionPolicy(): { enabled: boolean; allowlist: Set<string> };
// enabled = SUBAGENT_MODEL_SELECTION 为 "true"/"1" 且 allowlist 非空
export function assertRouteAllowed(route: string, policy, available: Model[]): void;
// 不在 allowlist → Error("路由 <route> 不在授权白名单")
// 在 allowlist 但不在 available → Error("路由 <route> 当前不可用")
export function assertThinkingLevel(level: string, model: Model): void;
// level 非 ThinkingLevel 枚举 → Error；model.reasoning 为假且 level !== "off" → Error("模型 <route> 不支持思考档")
```

factory 时 `const policy = readModelSelectionPolicy()` 算一次。

**关（`policy.enabled === false`）**
- `spawn_agent` 参数 schema 去掉：顶层 `model`、`tasks[]` 对象项的 `model`、`chain[].model`、inline `profile.model`。
- execute 开头：`params.model` / `params.thinking_level` / 任一 `tasks[].model` / `chain[].model` / `profile.model` 存在 → 返回 `isError`：`子代理路由选择未开启（设置 → 子代理 → 允许模型自选路由）`。不启动。
- 不注册 `list_subagent_models`。

**开**
- 上述 `model` 字段保留；描述改为「须来自 `list_subagent_models` 的路由；省略则用配置默认」。
- 新增顶层 `thinking_level?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`。
- execute：对每个显式 `model` 调 `assertRouteAllowed(route, policy, ctx.modelRegistry.getAvailable())`；`thinking_level` 存在时先解析目标模型（显式 `model` 或 `pickSubagentModel` 结果）再 `assertThinkingLevel`。任一失败 → `isError`，不启动任何单元（`tasks` 里一个坏就整批不跑，避免半批）。
- `promptGuidelines` 加：「开启自选路由时先 `list_subagent_models`；`fork: true` 换模型会失去前缀缓存，非必要不换。」

**不受白名单约束**（用户配置的默认，非模型选择）：named agent frontmatter `model`、profile 别名 `cheap` / `strong`、`SUBAGENT_MODEL`、父模型。`pickSubagentModel` 顺序不变。

**fork**：`fork: true` + 显式 `model` 允许，沿用规格 4 结论（Pi 按消息对象拷前缀，无字节级 KV 复用可保）。

### 5.3 发现工具（新文件 `extensions/multi-agent/list-models-tool.ts`）

仅 `policy.enabled` 时注册。

```
list_subagent_models({ provider?: string })
```

- 结果 = `policy.allowlist` ∩ `ctx.modelRegistry.getAvailable()`（按 `provider/id` 匹配）；`provider` 给出时只留该 provider。
- 每行：`provider/id — <name>；思考档：<集合>`。`reasoning` 为真给 SDK 全档，否则只有 `off`。
- 空交集 → 文本 `白名单内暂无可用模型`，不 `isError`。
- 子级 `buildExcludeTools` 加 `list_subagent_models`（子级没有 `spawn_agent`）。

### 5.4 执行透传

- `executeSubagent` opts 加 `thinkingLevel?: ThinkingLevel`。
- embedded：`createAgentSessionFromServices({ ..., thinkingLevel })`。
- 子进程：`runner.ts` `jsonModeArgs` 在 `--mode` 之前加 `--thinking <level>`（保持 `--skill` 在 `--mode` 前、task 末位的既有约定）。
- 省略则不传，子级用模型默认。
- `subagent_meta` 加 `thinkingLevel?: string`，供目录 / 覆层显示；缺省不写。

## 6. 错误

| 情况 | 结果 |
|---|---|
| 关 + 任何显式 `model` / `thinking_level` | `isError`，不启动 |
| 开 + 路由不在白名单 | `isError`：`路由 <x> 不在授权白名单` |
| 开 + 在白名单但目录里没有 | `isError`：`路由 <x> 当前不可用` |
| `thinking_level` 非枚举 / 模型不支持 | `isError`，不启动 |
| `tasks` 中一项不合法 | 整批不启动 |
| `modelRegistry.getAvailable()` 抛错 | 当空目录：显式路由一律「当前不可用」；未显式指定的路径不受影响 |
| 白名单 JSON 坏 | 当 `[]` → 开关视为关 |

## 7. 明确不做

- 策略快照进 JSONL；子级继承白名单
- 把 `model` 拆成 `provider` + `model` 两个参数
- 对 fork 禁止选路由
- 适配器专有 `reasoning_effort` id（统一用 SDK `ThinkingLevel`）
- `list_subagent_models` 的精确路由详情子命令（一次列表已含思考档）
- 已存不可用条目自动清理
- 让开关立即作用于已打开的会话

## 8. 测试

**`model-selection.test.ts`**
- 开关开 + 列表空 → `enabled: false`；开关关 + 列表非空 → `false`；都满足 → `true`
- JSON 坏 → `[]`
- `assertRouteAllowed`：白名单外 / 不可用 / 通过 三态
- `assertThinkingLevel`：非枚举、无 `reasoning` 给 `medium`、无 `reasoning` 给 `off`（通过）、有 `reasoning` 给 `high`（通过）

**`index.test.ts`**
- 关：schema 无顶层 `model`、`tasks` 项无 `model`、`chain` 项无 `model`、`profile` 无 `model`；execute 带各处 `model` / `thinking_level` 均 `isError` 且 `executeSubagent` 未调用
- 关：named agent `model` / `profile: "cheap"` / `SUBAGENT_MODEL` 仍传到 `executeSubagent`
- 开：白名单内且可用 → 启动；白名单外 → `isError`；`tasks` 一项坏 → 零启动
- 开：`thinking_level` 透传到 `executeSubagent` opts

**`list-models-tool.test.ts`**
- 关时未注册；开时交集、`provider` 过滤、空交集文案、思考档集合

**`embedded-runner.test.ts` / `runner.test.ts`**
- `thinkingLevel` → `createAgentSessionFromServices` 参数 / `--thinking` 参数位置在 `--mode` 前

**Electron**
- `settingsSchema.test.ts`：两键存在、`showWhen`
- `ModelListField.test.tsx`：多选存 JSON 数组；不可用条目显示并可移除；`SettingField` 分发 `model-list`
