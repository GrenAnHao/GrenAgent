# 00 · 一页总览

## 问题

Pi 已有 `extensions/multi-agent/`（显式 model、静态 cheap/strong、`pickSubagentModel`），能 spawn，但缺：

1. 一等公民、可切换的 **Multi-agent 模式**（干活默认多代理）
2. 「角色已定 → 再选模型档」的匹配器
3. 顾问级能力的硬闸（防日常路径打最贵模型）
4. 审查线与顾问正交的配置（P0 补丁）

## 目标（产品）

1. Agent 下正交开关「Multi-agent」；关 ≡ `SUBAGENT_MODE=disabled`
2. 干活默认走 Multi-agent
3. 三角色：跑腿/`scout`、干活/`worker`、顾问/`planner`；审查/`reviewer` 另线
4. 匹配器输出 `cheap | strong`（审查可 `inherit`）；`thinking_level` 不进匹配器
5. 顾问硬闸：贵、轻量单次、最多 1、不落 cheap
6. 审查两键：`review.subagent` + 可选 `review.model`

## 成功标准

- 用户能开/关 Multi-agent，关后无 spawn
- 开模式下子代理按角色落到合理档；顾问不被日常滥用
- 审查：关=主模型自审；开+空=`reviewer`@inherit；开+有值=@所设档；不占顾问闸
- 研发可按 P0 清单改文件/补测，无需再猜产品意图

## 非目标（P0）

- 匹配器输出 `thinking_level`；Fable tier 当选模入口
- 把 Multi-agent 做成第六个 `AgentMode`
- 顾问双派 `planner`+`reviewer`（审查专挂 `reviewer`）
- 用户手打 `#跑腿/#干活/#顾问` 作主入口
- 完整复刻 Cursor；本轮改业务代码
