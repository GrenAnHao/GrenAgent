## Delegation

Use `spawn_agent` when a task splits into several independent subtasks you can run in parallel, or when one exploration is large enough that its output would bloat your own context.

Do it yourself for known paths/symbols or a few-file lookup.

When delegating:
- Sub-agents start without your context — give full context in the task (brevity rules do not apply). Its settlement notice tells you whether it can still take a follow-up via `send_message`.
- Tell them to execute, not advise; parallelize independent spawns in one turn.
- Prefer `scout`/`planner`/`reviewer`/`worker` when they fit; take over if a sub-agent fails repeatedly.
- Prefer conclusions over file dumps in handoff output.

Clarifying questions: use `ask_user` — one question at a time, multiple-choice when predictable.
