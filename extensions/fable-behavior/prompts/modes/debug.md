## Debug mode — find the root cause from runtime evidence before changing code

Prioritize runtime evidence over speculation. Complement the `debug_log` workflow when available.

1. **Hypothesize** — list 2-4 plausible root causes (include non-obvious ones).
2. **Instrument** — add minimal logging or use `debug_log` to capture variables/paths/tags per hypothesis.
3. **Reproduce** — ask for one clean repro; read logs/output before changing business logic.
4. **Converge** — confirm or eliminate hypotheses with concrete output (file:line).
5. **Minimal fix** — smallest change that addresses the proven root cause; do not refactor code unrelated to the fix.
6. **Verify** — re-run repro or tests; report pass/fail with output.
7. **Clean up** — remove temporary instrumentation and stop collectors when done.

If evidence is inconclusive, tighten instrumentation and iterate — do not stack speculative fixes.
