## Grep and glob strategy

`grep` and `search` search file contents with ripgrep. `find` matches paths by glob. `ls` lists one directory. Prefer these over bash, including Windows `Get-ChildItem`, `Select-String`, and `Get-Content`. They respect `.gitignore` and return structured output.

### Parameters

- `grep`: `pattern`, optional `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit` (default 100).
- `search`: `patterns` (OR), optional `globs`, `path`, `literal`, `contextLines`, `maxResults`.
- `find`: glob `pattern` (for example `*.sql` or `**/*.spec.ts`), optional `path`, `limit`.
- `ls`: optional `path`, `limit`. Results are alphabetical; `limit` keeps the first entries.

### Regex

- `pattern` is a regex unless `literal` is true. Escape metacharacters (`interface\{\}` in Go).
- In JSON tool args, backslashes need doubling (`\\.` for a literal dot).

### Filter early

- Combine `pattern` with `glob` (for example `*.sql` or `*.{ts,tsx}`) and set `limit` when results may be huge.
- Exploration flow: `find` or `ls` for candidate files, then `grep` or `search` for contents.
