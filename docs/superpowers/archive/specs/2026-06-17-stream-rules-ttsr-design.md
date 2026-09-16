# 规则引擎（Rulebook）+ 时间旅行流规则(TTSR) 设计

- 日期：2026-06-17
- 状态：设计待评审（来自 oh-my-pi 借鉴评估，5 项之一）
- 主题：给 Pi 一个**规则库 + 跑偏纠正**机制。对标 omp 的 TTSR（time-traveling stream rules）："规则平时休眠，模型一跑偏，正则命中即**中断流**、注入规则、从原点重试，且注入存活上下文压缩"。**重要约束**：上游 `pi-coding-agent@0.79.4` 无可中断的 token 级流钩子，omp 的"mid-token 中断"无法原生复刻；Pi 落地为**工具边界即时纠正 + turn 级输出检测纠正**的等效方案，并把现有 `loop-guard` 收编为其中一条内置规则。

## 1. 背景与目标

### 现状
Pi 有 `loop-guard`（`tool_call` 钩子：连续 N 次相同调用 / 单轮调用超上限 → `block + reason` 回灌纠正）。这其实已是"工具边界纠正"的雏形，但**规则是写死的**，无法让用户/项目自定义"何种行为该被纠正、注入什么规则"。

### omp 的做法（TTSR）
规则休眠，命中正则 → abort 流 mid-token → 注入规则为 system reminder → 从同点重试；注入物存活 compaction，所以修正"粘住"。背后是 omp fork 内核、在 provider streaming 层挂了可中断钩子 + rulebook 匹配管线。

### 上游约束（已核实）
`ExtensionAPI` 事件里 `MessageStart/Update/End` 是**只读通知**（无 `*Result` 返回口），只有 `ToolCallEvent`/`BeforeAgentStartEvent`/`SessionBeforeCompact` 等有 `*Result` 可影响流程。→ **无法在 token 流中途中断重试**。

### 成功标准
1. 用户/项目可声明**规则**：`{ 触发条件 → 注入的规则文本 }`，热加载。
2. 触发条件命中时**即时纠正**：工具类触发走 `tool_call` 的 `block+reason`（等效 omp 的即时性，发生在工具边界）。
3. 文本输出跑偏（无工具调用）：`turn_end` 检测 → 下一轮 `before_agent_start` 注入规则纠正（非同轮中断，但能纠偏）。
4. 注入**存活 compaction**：规则以每轮重注 / 持久 system reminder 方式留存。
5. `loop-guard` 收编为内置规则，阈值仍可配。

### 非目标
- 不 fork 上游内核去实现真正的 mid-token abort（成本过高、维护负担大）。
- 不做语义级（LLM 判别）规则匹配（一期用正则/glob/工具名）。

## 2. 现状盘点
| 关注点 | 现状 |
|---|---|
| 工具边界拦截 | `loop-guard` 用 `tool_call → {block,reason}` |
| 轮次钩子 | `before_agent_start`(可注入 message)、`turn_end`(只读助手消息)、`agent_end` |
| 规则来源 | 无统一 rulebook；`.cursor/rules/*.mdc` 是 IDE 侧、不进 sidecar |
| 压缩存活 | `before_agent_start` 每轮注入天然存活；或 `customType` 持久消息 |

## 3. 架构总览
```
extensions/rulebook/
  rules.ts      规则模型 + 加载/热重载（.pi/rules.jsonc 或 .pi/rules/*.md frontmatter）
  match.ts      匹配：toolName / 参数 glob / 文本 regex / 路径 glob（纯函数，可单测）
  inject.ts     注入策略：tool_call block-reason / before_agent_start system reminder
  index.ts      挂钩子：tool_call(即时) + turn_end(检测) + before_agent_start(注入+重注)
  builtins.ts   内置规则：收编 loop-guard（重复/超量）
```

## 4. 规则模型
```ts
interface Rule {
  id: string;
  when:
    | { kind: 'tool'; tool: string; argsMatch?: Record<string,string> }  // 工具+参数 glob
    | { kind: 'text'; pattern: string }                                  // 助手文本 regex
    | { kind: 'path'; tool: 'edit'|'write'|'hl_edit'; glob: string };    // 改到某些路径
  action: 'block' | 'warn' | 'inject';   // block=工具边界拦截; inject=下轮注入; warn=仅提示
  rule: string;                          // 注入/拦截时给模型的规则文本
  once?: boolean;                        // 是否只注入一次（默认每次命中都生效）
  persist?: boolean;                     // 是否作为持久 system reminder（存活 compaction）
}
```
来源：`.pi/rules/*.md`（frontmatter 定义 when/action + 正文为 rule）或 `.pi/rules.jsonc`。可继承 `.cursor/rules` 文本（仅作 persist inject，无触发器）。

## 5. 触发与注入
- **工具类（`when.kind='tool'|'path'`，`action='block'`）**：`tool_call` 钩子匹配 → 返回 `{block:true, reason: rule}`，即时纠正（与 loop-guard 同机制，发生在工具调用前）。
- **文本类（`when.kind='text'`）**：`turn_end` 读助手输出，命中 → 标记"待注入"；下一轮 `before_agent_start` 注入 `rule` 为 system reminder（customType `rulebook-reminder`, display:false）。**这是 mid-token 中断的 turn 级替代**。
- **持久（`persist`）**：每轮 `before_agent_start` 重注（天然存活 compaction）。
- **去重**：`once`/已注入集合避免刷屏。

## 6. 工具/命令
- `/rules`：列出当前生效规则；`/rules reload` 热重载。
- （可选）`rule_add` 工具：让模型/用户在会话内临时加一条规则。

## 7. pi 端改动
- 新扩展 `extensions/rulebook/`。
- `loop-guard` 重构为 `builtins.ts` 的两条内置规则（阈值沿用 `LOOP_GUARD_*` 配置），或保留 loop-guard 独立、rulebook 仅做用户规则（**决策 D1**）。
- 前端（可选）：注入规则时在对话流给一张 "⚠ 已注入规则 X" 的轻提示卡（对标 omp 的注入卡）。

## 8. 拆解（分阶段）
| 阶段 | 范围 | 依赖 |
|---|---|---|
| 1 | 规则模型 + 加载 + `match`(纯函数单测) + 工具类 `block` 注入 | 无 |
| 2 | 文本类 `turn_end` 检测 + `before_agent_start` 注入 + persist 重注 | 1 |
| 3 | `/rules` 命令 + 前端注入提示卡 | 2 |
| 4 | 收编 loop-guard 为内置规则 | 1 |

## 9. 关键决策
- **D1 是否收编 loop-guard**：建议收编（统一为 rulebook 内置规则），避免两套重复机制；保留环境变量兼容。
- **D2 注入时机**：文本类无法同轮中断 → 明确产品预期是"下一轮纠正"，并在规则文本里要求模型"撤回上一步的偏差"。
- **D3 规则来源格式**：`.pi/rules/*.md`（frontmatter）便于人写；同时继承 `.cursor/rules` 文本做 persist。
- **D4 匹配成本**：每个 `tool_call`/`turn_end` 跑正则集合，规则数大时加编译缓存。

## 10. 风险与注意
- **达不到 omp 的即时性**：纯文本跑偏只能下轮纠正——需在文档/prompt 里设定预期。若未来上游加可中断流钩子，可平滑升级 inject.ts。
- **注入刷屏**：`once`/去重 + persist 重注的节流要做好，否则上下文被规则塞满。
- **误伤**：正则过宽会频繁拦截正常行为——规则默认保守，提供 `warn` 档先观察。
- **与 hashline/agent-mode 协同**：`path` 类规则要兼容 `hl_edit` 的工具名。
