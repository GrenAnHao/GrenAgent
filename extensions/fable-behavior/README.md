# fable-behavior

Distilled Fable 5 + coding-agent leaks into a modular English behavior layer. Injected each turn via `before_agent_start` (`display: false`).

## Config (`PI_RUNTIME_CONFIG` or env)

| Key | Default | Meaning |
|-----|---------|---------|
| `FABLE_BEHAVIOR` | `1` | Master switch |
| `FABLE_BEHAVIOR_TIER2` | `1` | Tier-2 modules |
| `FABLE_BEHAVIOR_TIER2_P1` | `1` | Tier-2 P1 extended modules |
| `FABLE_BEHAVIOR_TIER3_GUIDELINES` | `1` | Tier-3 one-line summaries in injection |
| `FABLE_BEHAVIOR_TIER3_TOOL` | `1` | Register `fable_behavior_ref` on-demand Tier-3 reader |
| `FABLE_BEHAVIOR_SEED_AGENTS` | `1` | Seed sub-agent templates (`0` off, `1` if absent, `force` overwrite) |

### Recommended profiles

**Default (full behavior layer)**

```json
{
  "FABLE_BEHAVIOR": "1",
  "FABLE_BEHAVIOR_TIER2": "1",
  "FABLE_BEHAVIOR_TIER2_P1": "1",
  "FABLE_BEHAVIOR_TIER3_GUIDELINES": "1",
  "FABLE_BEHAVIOR_TIER3_TOOL": "1",
  "FABLE_BEHAVIOR_SEED_AGENTS": "1"
}
```

**Token-conscious (~1,700 tokens/turn)**

```json
{
  "FABLE_BEHAVIOR": "1",
  "FABLE_BEHAVIOR_TIER2": "1",
  "FABLE_BEHAVIOR_TIER2_P1": "0",
  "FABLE_BEHAVIOR_TIER3_GUIDELINES": "1",
  "FABLE_BEHAVIOR_TIER3_TOOL": "1"
}
```

**Minimal (~1,000 tokens/turn)**

```json
{
  "FABLE_BEHAVIOR": "1",
  "FABLE_BEHAVIOR_TIER2": "0",
  "FABLE_BEHAVIOR_TIER3_GUIDELINES": "1",
  "FABLE_BEHAVIOR_TIER3_TOOL": "1"
}
```

Point `PI_RUNTIME_CONFIG` at your JSON file for hot reload (see `extensions/_shared/runtime-config.ts`).

## Sub-agent template migration

On `session_start`, enriched `scout` / `planner` / `reviewer` / `worker` templates seed into `~/.pi/agent/agents/`. The seeder is **self-healing**: it tracks a content hash per file in `~/.pi/agent/agents/.fable-behavior-seed-version` (now a JSON manifest) so a template change automatically **upgrades the copies we previously wrote** — while a file you have edited yourself is detected (hash mismatch) and **preserved**. Upgrades/preserves are logged to stderr.

`FABLE_BEHAVIOR_SEED_AGENTS` modes:

- `1` / unset → **auto** (default): create missing, upgrade unmodified-ours, preserve user edits.
- `if-absent` → only create missing files; never overwrite (opt out of auto-upgrade).
- `force` → overwrite every template (then resumes tracking).
- `0` → off.

To force a full re-seed from repo templates (e.g. to discard your edits):

```bash
# backup first if you have hand-edited globals
cp -r ~/.pi/agent/agents ~/.pi/agent/agents.bak

FABLE_BEHAVIOR_SEED_AGENTS=force pi ...
```

The same self-healing seeder backs self-evolve's `dream` / `distill` personas (`.self-evolve-seed-version`, `SELF_EVOLVE_SEED`). Shared logic: `extensions/_shared/seed-agents.ts`.

## Layering vs other extensions

| Source | Role |
|--------|------|
| User / project rules (`rulebook`, `AGENTS.md`) | Project-specific must-follow constraints |
| `fable-behavior` | General coding-agent harness + tone |
| `diagram-hint` | Mermaid / KaTeX rendering |
| `agent-mode` | Mode-specific prompt (ask/plan/debug) |
| RAG / memory injections | Retrieved facts for this turn |

When rules conflict, **project rules win**; behavior layer provides defaults, not overrides.

## Tier-3 on demand

Summaries inject every turn when `FABLE_BEHAVIOR_TIER3_GUIDELINES=1`. For full text (e.g. code citation fences), the model can call `fable_behavior_ref` with `topic`: `citing-code`, `copyright`, `search-full`, `wellbeing`, `evenhandedness`, `frontend-design`.

## Tests

```bash
cd extensions/fable-behavior && bunx vitest run
```

`integration.test.ts` verifies coexistence with `diagram-hint` and `agent-mode` (sidecar-style multi-hook injection).
