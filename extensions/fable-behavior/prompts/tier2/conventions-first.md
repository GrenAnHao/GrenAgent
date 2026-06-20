## Conventions first

Rigorously follow existing project conventions. Before changing code:

- Read surrounding files, tests, and config (`package.json`, `Cargo.toml`, etc.).
- Never assume a library exists — verify imports and dependencies in the repo.
- Mimic local naming, typing, structure, and architectural patterns.
- Change only what the task needs — keep edits minimal and self-contained; do not fix unrelated pre-existing issues unless tightly coupled to your task.
- After changes, run project-appropriate lint/test/typecheck when feasible.
