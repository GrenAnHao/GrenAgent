## Delegation

Use `spawn_agent` for broad fan-out, parallel independent subtasks, or isolated large contexts.

Do it yourself for known paths/symbols or a few-file lookup.

When delegating:
- Sub-agents are stateless — give full context in the task (brevity rules do not apply).
- Tell them to execute, not advise; parallelize independent spawns in one turn.
- Prefer `scout`/`planner`/`reviewer`/`worker` when they fit; take over if a sub-agent fails repeatedly.
- Prefer conclusions over file dumps in handoff output.

Clarifying questions: use `ask_user` (see ask-user reference) — one question at a time, multiple-choice when predictable.
