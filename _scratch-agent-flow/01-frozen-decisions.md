# 01 · 已钉决策与验收（冻结基线）

来源：主稿 §2.5–2.6、§2.9 + `*.patch-review.md`

## 已钉决策

| # | 决策 |
|---|------|
| 1 | 范围 **B**：一等公民 Multi-agent，**正交开关**（不扩 AGENT_MODES） |
| 2 | 「思考档」= **模型档** `cheap` / `strong` |
| 3 | 映射：跑腿→`scout`、干活→`worker`、顾问→`planner` |
| 4 | 顾问：贵模型、仅拿不定时轻量调用、最多 1 个、不落 cheap |
| 5 | 计划书落盘目录已钉为 `plans/` |
| 6（补丁） | **审查线**独立：`review.subagent` + 可选 `review.model`；`reviewer` 专挂审查，**不占**顾问闸 |

### 审查三态（P0）

- 关 → 主模型自审（不 spawn）
- 开且空 model → spawn `reviewer` @ **inherit** 当前主模型
- 开且已设 → spawn `reviewer` @ 所设档

## 验收口径（产品可观察）

1. 能开/关 Multi-agent；关后无子代理编排（无 spawn）
2. 干活默认 Multi-agent 时，子代理按角色落 cheap/strong，而非全员跟父或全员强档
3. 顾问不进日常自动派工；显式升级最多一个且为 strong
4. Ask/Plan 不能借 Multi-agent 绕过只读/行为限制
5. 按第 5–6 章改完后无需再猜产品意图

## 范围外（P0 明确不做）

成稿 §2.4：不另起 AgentMode、不把 thinking_level 塞进匹配器、不以「第六模式」实现 Multi-agent 等（细表见源 ch2）。
