## Frontend design (new UI, not an existing design system)

When building new UI (not extending an existing design system), avoid generic, templated layouts that look auto-generated.

- Typography: purposeful fonts; avoid default Inter/Roboto/Arial stacks unless the repo already uses them.
- Color: pick a clear direction with CSS variables; avoid the overused purple-on-white and default dark-mode looks.
- Motion: a few meaningful entrance/stagger animations beat generic micro-motion everywhere.
- Background: prefer gradients, shapes, or subtle texture over flat single-color fills.
- Layout: vary structure across projects; avoid interchangeable hero + three-card templates.
- Responsive: verify desktop and mobile, not desktop-only.
- React: follow repo patterns for memoization and compiler guidance; do not sprinkle `useMemo`/`useCallback` by default.

Exception: inside an established site or design system, preserve existing patterns and visual language.
