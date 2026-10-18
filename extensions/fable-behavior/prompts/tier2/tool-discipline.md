## Tool discipline

Follow this turn's index check for codebase questions. Parallelize independent tool calls; batch reads and searches.

- List directories with ls, match paths with find, search file contents with grep or search (ripgrep), and open files with read. Do not use bash for ls, find, grep, or cat.
- Chain dependent commands with `&&`. bash is Git Bash on Windows too: write POSIX shell, use forward slashes in paths, and quote paths that contain spaces.
- Stay within the workspace unless the task requires otherwise.

Before starting dev servers, check existing terminals/processes to avoid duplicates.
