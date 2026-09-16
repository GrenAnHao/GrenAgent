# Fable Behavior Fusion — System Prompt Layer

- Date: 2026-06-20
- Status: shipped
- Sources: `CLAUDE-FABLE-5-full.md`, [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks) (Claude Code, Cursor, Copilot, Codex, OpenCode)
- Delivery: extension `extensions/fable-behavior/` with Tier C priority injection

## Goal

Distill general behavioral DNA (Fable 5) plus coding-agent harness rules (leaks repo) into a modular English prompt layer for Pi/GrenAgent, without forking `buildSystemPrompt`.

## Architecture

```
buildSystemPrompt()           # unchanged
  -> fable-behavior extension
       Tier-1  before_agent_start (every turn)
       Tier-2  before_agent_start (compressed, every turn when enabled)
       Mode    ask/plan/debug slices from session agent-mode entry
       Tier-3  one-line summaries appended when FABLE_BEHAVIOR_TIER3_GUIDELINES=1
  -> existing extensions (diagram-hint, safety, agent-mode, ...)
```

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `FABLE_BEHAVIOR` | `1` | Master switch |
| `FABLE_BEHAVIOR_TIER2` | `1` | Include Tier-2 modules |
| `FABLE_BEHAVIOR_TIER2_P1` | `1` | Include Tier-2 P1 extended modules (delegation, terminal-harness, verify-baseline, etc.) |
| `FABLE_BEHAVIOR_TIER3_GUIDELINES` | `1` | Append Tier-3 summary block |
| `FABLE_BEHAVIOR_TIER3_TOOL` | `1` | Register `fable_behavior_ref` for on-demand Tier-3 full text |
| `FABLE_BEHAVIOR_SEED_AGENTS` | `1` | Seed enriched sub-agent templates if absent (`force` overwrites) |

## Module map

### Tier-1 (every turn)

| File | Source |
|------|--------|
| `identity.md` | Pi identity (not Anthropic product copy) |
| `tone.md` | Fable tone_and_formatting |
| `mistakes.md` | Fable responding_to_mistakes |
| `file-verify.md` | Fable file-presence check |
| `coding-harness.md` | Claude Code harness + Cursor tool_calling |
| `autonomy.md` | Codex GPT-5.5 autonomy |

### Tier-2 (compressed every turn)

| File | Source |
|------|--------|
| `tool-discipline.md` | Cursor + Claude grep-tool + Copilot priority |
| `ask-user.md` | Cursor/Copilot ask_user + QuestionsCard UI |
| `grep-strategy.md` | Claude Code grep-tool (output modes, regex, filter) |
| `mcp-collaboration.md` | Claude Code Opus 4.8 MCP harness rules |
| `refusal.md` | Fable + Opus authorized security boundaries |
| `skills-first.md` | Fable computer_use/skills + Pi skills |
| `file-workflow.md` | Fable file_creation + Cursor read-before-edit |
| `conventions-first.md` | OpenCode core mandates |
| `verify-baseline.md` | Copilot lint/build/test baseline workflow |
| `git-hygiene.md` | Codex dirty worktree + Cursor git |
| `editing-constraints.md` | Codex auto-review editing constraints |
| `delegation.md` | Claude Code Agent + Copilot explore/manager mode |
| `terminal-harness.md` | OpenCode CLI visibility, bash, risky-action gates |
| `knowledge-search-triggers.md` | Fable knowledge_cutoff triggers |

### Tier-3 (summaries / sub-agent bodies)

`search-full.md`, `copyright.md`, `wellbeing.md`, `evenhandedness.md`, `citing-code.md`, `frontend-design.md`

### Mode slices

| Mode | Extra |
|------|-------|
| ask | search tier-3 summary |
| plan | Codex plan_mode three phases + non-mutating boundary (also in enhanced PLAN_PROMPT) |
| debug | Codex/Cursor evidence loop + debug_log alignment |
| agent | ask_user reminder (QuestionsCard) |

## Boundaries

- Complements `diagram-hint`, `safety`, `loop-guard`, `agent-mode` — does not replace.
- Excludes: Anthropic product ads, artifact storage API, tool JSON schemas, browser GIF rules.
- Sub-agent seed: skip if `~/.pi/agent/agents/<name>.md` already exists.

## Token budget (approximate, per turn)

Measured via `estimatePromptTokens()` (chars / 4). Tier-3 **full** `.md` files on disk are not injected — only one-line summaries.

| Profile | Config | ~tokens |
|---------|--------|---------|
| Minimal | `FABLE_BEHAVIOR_TIER2=0` | ~750 (Tier-1 only) + ~260 summaries if Tier-3 on |
| Core harness | `FABLE_BEHAVIOR_TIER2_P1=0` | ~1,700 (Tier-1 + Tier-2 P0 + summaries) |
| Default (full) | all `1` | ~3,000–3,700 (+ mode slice in plan/debug) |

Other extensions also inject per turn (`diagram-hint` ~400 chars, `agent-mode` mode prompt in plan/debug, RAG/memory when enabled). Default fable-behavior is moderate — not catastrophic for 128k+ contexts, but use P1=0 or Tier2=0 on token-sensitive runs.

Tier-2 P0 (always when Tier2 on): tool-discipline, grep-strategy, mcp-collaboration, refusal, skills-first, file-workflow.

Tier-2 P1 (optional): conventions-first, verify-baseline, git-hygiene, editing-constraints, delegation, terminal-harness, knowledge-search-triggers.

## Tests

- `loader.test.ts` / `index.test.ts` / `seed.test.ts`: module assembly, config switches
- `integration.test.ts`: coexistence with `diagram-hint` + `agent-mode` (sidecar multi-hook)
- Smoke: `FABLE_BEHAVIOR=1` yields non-empty `before_agent_start` message
