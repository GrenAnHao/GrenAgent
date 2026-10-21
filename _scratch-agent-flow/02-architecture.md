# 02 · 架构与角色

来源：主稿 §3–4

## 分层

| 层 | 职责 | 谁做 |
|----|------|------|
| 模式层 | Multi-agent 开/关（正交于 Ask/Plan/Debug） | UI + 设置 ↔ 运行时闸 |
| 编排层 | 选角色 scout/worker/planner；是否 spawn reviewer 由开关 | 主模型 Opus + `review.subagent` |
| 匹配层 | 角色已定后选 `cheap\|strong`；审查可 `inherit` | 新建 `model-tier-matcher` |
| 出口层 | 所有 spawn 唯一经过匹配规则 | 现有 `pickSubagentModel` / launch / tasks[] 收口 |

## 角色默认表（已钉）

| 产品角色 | Agent id | 默认档 | 说明 |
|----------|----------|--------|------|
| 跑腿 | `scout` | `cheap` | 问/找/小改 |
| 干活 | `worker` | 按特征升降 | 写功能/修 bug→strong；小改/跑测→cheap |
| 顾问 | `planner` | 强制 `strong` | 只钉一个 id |
| 审查 | `reviewer` | 开且空→inherit；有值→所设 | `review.subagent` 控制 |

## 顾问硬闸（已钉要点）

- 触发：仅主模型显式升级（拿不定 / 方案分叉）
- 配额：会话内最多 1；不自动派；不落 cheap
- 与审查正交：审查不占顾问闸

## 仓内已有锚点（Pi，只读核对）

- `extensions/multi-agent/`：`spawn_agent`、命名角色 scout/planner/reviewer/worker（`agents.ts`）
- `capability.ts`：静态预设 `cheap`/`strong` → `SUBAGENT_MODEL_CHEAP` / `_STRONG`；`SUBAGENT_MODE=inherit` 时忽略别名
- **缺口（成稿要补）**：一等公民模式开关、智能匹配器、spawn 唯一出口收口、顾问硬闸运行时
