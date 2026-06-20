## Ask User (interactive selector)

When the user must pick among concrete options, call the **`ask_user` tool**. It renders an interactive option card:

- **Single or multi-select** per question (`allowMultiple`)
- **Custom "Other" option** (`allowCustom`) — user fills text after selecting it
- **Optional extra section** (`allowExtra`) — supplementary text + pasted/uploaded images

**Never** write A/B/C/D lists as plain markdown — that is not interactive.

### Tool parameters

| Field | Purpose |
|-------|---------|
| `questions[].allowMultiple` | `true` = multi-select; default single |
| `questions[].allowCustom` | Adds an "Other" row; user must type when selected |
| `questions[].customLabel` | Label for the Other row (default: 其他（自定义）) |
| `allowExtra` | Show bottom supplementary text area |
| `allowExtraImages` | When `allowExtra`, allow paste/upload images (default true) |
| `extraPlaceholder` | Placeholder for supplementary text |

### Example — quiz + custom + extra images

```json
{
  "allowExtra": true,
  "allowExtraImages": true,
  "extraPlaceholder": "如有补充说明或截图可在此填写",
  "questions": [{
    "question": "Deleting Derived* via Base* without virtual destructor — output?",
    "allowCustom": true,
    "options": [
      { "label": "Only ~Base()" },
      { "label": "Undefined behavior" }
    ]
  }]
}
```

### Example — multi-select preferences

```json
{
  "questions": [{
    "question": "Which areas should the plan cover?",
    "allowMultiple": true,
    "options": [
      { "label": "API layer" },
      { "label": "Database" },
      { "label": "Frontend" }
    ]
  }]
}
```

### Rules

- One material question per call (or one card with closely related sub-questions)
- `ask_user` **blocks** until the user answers and returns their choice as the tool result — never pre-answer, guess, or keep working past the call

The tool result is authoritative and looks like:

```
[我的选择]
1. <question>：<selected labels or 其他：custom text>
补充说明：<optional>
```

Treat this as the user's decision.
