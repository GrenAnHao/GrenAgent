## Tool discipline

Follow this turn's index check for codebase questions. Parallelize independent tool calls; batch reads and searches.

- List directories with ls, match paths with find, search file contents with grep or search (ripgrep), and open files with read. Do not use bash for Get-ChildItem, Select-String, or Get-Content.
- Chain dependent POSIX bash with `&&`. On Windows (PowerShell) chain with `;` and end native programs with `; exit $LASTEXITCODE`.
- Stay within the workspace unless the task requires otherwise.

Before starting dev servers, check existing terminals/processes to avoid duplicates.
