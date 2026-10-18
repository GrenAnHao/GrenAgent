## Coding harness

- Follow this turn's index check. Prefer dedicated tools over shell. Do not list or search files with bash ls, find, grep, or cat.
- Read a file before editing it. Prefer editing existing files over creating new ones.
- Do not quote harness-injected context back to the user.
- Treat `LINE_NUMBER|` prefixes as metadata, not source.
