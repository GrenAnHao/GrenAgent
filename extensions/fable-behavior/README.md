# fable-behavior

GrenAgent 行为核：每轮 `before_agent_start` 注入身份、语气、自主、拒绝与当前模式片（`display: false`）。工具目录和参数纪律不在这里，走 Pi 的 `promptSnippet` / `promptGuidelines` 与各扩展每轮 hint。

## 默认注入

- Kernel：`identity`（只补 GrenAgent 产品句，不复述官方「You are an expert coding assistant」） / `tone` / `mistakes` / `file-verify` / `coding-harness` / `autonomy` / `refusal`
- 当前模式片：`ask` / `plan` / `debug` / `brainstorm`（Agent 默认无额外片；`ask_user` 纪律只在工具 Guidelines）
- `session_start` 播种 `scout` / `planner` / `reviewer` / `worker`
- `fable_behavior_ref`：按需取 Tier-3 全文（引用格式、版权、前端设计等）

## Config (`PI_RUNTIME_CONFIG` or env)

| Key | Default | Meaning |
| --- | --- | --- |
| `FABLE_BEHAVIOR` | `1` | Master switch |
| `FABLE_BEHAVIOR_TIER2` | off | Opt-in leftover tool manuals（与官方工具字段重叠，默认关闭） |
| `FABLE_BEHAVIOR_TIER2_P1` | `1` | 仅在 Tier-2 打开时附加 P1 手册 |
| `FABLE_BEHAVIOR_TIER3_GUIDELINES` | off | Opt-in 每轮灌 Tier-3 一行摘要 |
| `FABLE_BEHAVIOR_TIER3_TOOL` | `1` | 注册 `fable_behavior_ref` |
| `FABLE_BEHAVIOR_SEED_AGENTS` | `1` | Seed sub-agent templates（`0` off，`1` if absent，`force` overwrite） |

恢复旧的厚注入（不推荐）：

```json
{
  "FABLE_BEHAVIOR_TIER2": "1",
  "FABLE_BEHAVIOR_TIER3_GUIDELINES": "1"
}
```

Point `PI_RUNTIME_CONFIG` at your JSON file for hot reload (see `extensions/_shared/runtime-config.ts`).

## Sub-agent template migration

On `session_start`, enriched `scout` / `planner` / `reviewer` / `worker` templates seed into `~/.pi/agent/agents/`. The seeder is **self-healing**: it tracks a content hash per file in `~/.pi/agent/agents/.fable-behavior-seed-version` so a template change automatically **upgrades the copies we previously wrote** — while a file you have edited yourself is detected (hash mismatch) and **preserved**.

`FABLE_BEHAVIOR_SEED_AGENTS` modes:

- `1` / unset → **auto** (default): create missing, upgrade unmodified-ours, preserve user edits.
- `if-absent` → only create missing files; never overwrite.
- `force` → overwrite every template (then resumes tracking).
- `0` → off.

The shared seeder lives in `extensions/_shared/seed-agents.ts`.

## Layering vs other extensions

| Source | Role |
| --- | --- |
| User / project rules (`rulebook`, `AGENTS.md`) | Project-specific must-follow constraints |
| Tool `promptSnippet` / `promptGuidelines` | Available tools + named discipline |
| Per-turn hints（如 CodeGraph 索引） | 本轮才知道的事实 |
| `fable-behavior` | Identity, tone, autonomy, mode, seed |
| `diagram-hint` | Mermaid / KaTeX rendering |
| `agent-mode` | Tool whitelist + plan execution checklist |
| RAG / memory injections | Retrieved facts for this turn |

When rules conflict, **project rules win**.

## Tests

```bash
cd extensions && npx vitest run fable-behavior
```
