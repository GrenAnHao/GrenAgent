# P0 任务地图（分析用，非开工令）

> 来源：ch5 + ch6 + 审查补丁。本轮用户要求：**先分析、不做落地**。本表仅作归纳，不是「去改仓」。

## 依赖顺序

```
0 正交开关 ──┬── 0.5 主模型 Opus（可与 1 并行）
             │
1 匹配器 ────┼── 2 唯一出口 ──┐
             └── 3 角色表 ────┴── 4 顾问硬闸
                                      │
5 审查线（§6.11）可与 2/3 并行，须复用 0 的关闸；不占顾问计数
```

| 序号 | 任务 | 关键落点（符号） | 验收锚 |
|------|------|----------------|--------|
| 0 | Multi-agent 正交开关 | `settingsSchema` 新布尔；`multi-agent/index.ts` 拒 spawn；**勿**扩 `AGENT_MODES` | 关≡disabled；Ask/Plan 不回归 |
| 0.5 | 主模型钉 Opus | 会话默认 / 编排入口；**禁止**进匹配器 | 开=Opus；关=不改用户自选 |
| 1 | `model-tier-matcher` | 新建 `model-tier-matcher.ts` | scout cheap；worker 按 hints；planner 永不 cheap |
| 2 | spawn 唯一出口 | `pickSubagentModel` 后挂匹配器；`launchEarly`/`tasks[]` | 显式 model 不被覆盖 |
| 3 | 角色默认表 | `agents.ts` / capability 对齐 scout·worker·planner | 顾问≠reviewer |
| 4 | 顾问硬闸 | 计数只认 `planner` | 最多 1；强→强失败；不降 cheap |
| 5 | 审查开关+模型 | `REVIEW_SUBAGENT` / `REVIEW_MODEL`；spawn `reviewer` | 关不 spawn；空=inherit；有值=所配；不占顾问 |

## 优先级链（匹配器介入）

1. 显式 model → 2. frontmatter → 3. profile/`SUBAGENT_MODEL*` → **4. 匹配器** → 5. 父模型回落

审查特例：`REVIEW_MODEL` 空 → **inherit 父模型**，禁止套用 reviewer/planner 的 strong 预设。

## 全局验收（整包）

- 开：可按角色 spawn，档位匹配生效，顾问/审查行为符合上表  
- 关：不 spawn、不跑匹配器  
- Ask/Plan/Debug 工具闸与改前一致  
