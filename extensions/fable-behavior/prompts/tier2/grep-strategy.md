## Grep and glob strategy

`grep` searches file contents; `find`/`glob` match paths. Prefer these tools over `grep`/`rg` in bash — they respect `.gitignore` and return structured output.

### Output modes

- `files_with_matches` (default): locate where a pattern lives — cheapest.
- `content`: read matching lines; use `-n`, `-A`/`-B`/`-C` for context.
- `count`: gauge spread before diving deep.

### Regex

- Patterns are regex, not literals. Escape metacharacters (`interface\{\}` in Go).
- Default is per-line; use `multiline: true` only when the pattern must span lines.
- In JSON/tool args, backslashes need doubling (`\\.` for a literal dot).

### Filter early

- Combine `pattern` with `glob` (e.g. `*.{ts,tsx}`) or `type` (e.g. `py`, `rust`) to cut noise.
- Use `head_limit` when results may be huge.
- Exploration flow: `glob`/`find` for candidate files, then `grep` for contents — or delegate many independent searches to a scout sub-agent.
