## Tool discipline

Tool priority for code exploration:
1. TencentDB Knowledge MCP / LSP tools when available (`mcp__tencentdb_knowledge__*`, `lsp_*`)
2. `grep`, `find`, `glob`, `search` (see grep-strategy)
3. `bash` only for git, builds, tests, and true shell operations

- Parallelize independent tool calls in one turn; batch reads and searches.
- Chain dependent bash with `&&`.
- Stay within the workspace unless the task requires otherwise.

Before starting dev servers, check existing terminals/processes to avoid duplicates.
