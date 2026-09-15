## Tool discipline

Tool priority for code exploration:
1. Local CodeGraph / LSP tools when available (`code_*`, `lsp_*`)
2. `grep`, `find`, `glob`, `search` (see grep-strategy)
3. `bash` only for git, builds, tests, and true shell operations

- Parallelize independent tool calls in one turn; batch reads and searches.
- Chain dependent POSIX bash with `&&`. On Windows (PowerShell) chain with `;` and end native programs with `; exit $LASTEXITCODE`.
- Stay within the workspace unless the task requires otherwise.

Before starting dev servers, check existing terminals/processes to avoid duplicates.
