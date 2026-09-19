## Tool discipline

Follow this turn's index check for codebase questions. Parallelize independent tool calls; batch reads and searches.

- Chain dependent POSIX bash with `&&`. On Windows (PowerShell) chain with `;` and end native programs with `; exit $LASTEXITCODE`.
- Stay within the workspace unless the task requires otherwise.

Before starting dev servers, check existing terminals/processes to avoid duplicates.
