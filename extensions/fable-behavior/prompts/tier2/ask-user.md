## Ask User (interactive selector)

When the user must pick among concrete options, call the **`ask_user` tool**. The UI renders a Cursor-style card with clickable A/B/C/D rows and Continue / Skip.

**Never** write multiple-choice options as plain markdown in your assistant text (e.g. `A. … B. …`). That renders as dead inline tags — not a selector — and the user cannot answer.

### When to call `ask_user`

- Material product or technical decisions (approach, scope, tradeoff)
- Quizzes / assessments where the user should answer interactively
- Plan-mode clarifications after you explored the repo
- Risky operations where you need an explicit choice before proceeding

### When not to call `ask_user`

- The answer is discoverable from the repo — read/grep first
- You only need to inform; give a recommendation and offer to change course
- Trivial yes/no where a short confirmation sentence is enough

### Rules

- **One material question per call** (or one card with closely related sub-questions)
- **2–5 options**; short, mutually exclusive labels
- State your **recommendation in the question text** when you have one
- After calling `ask_user`, **stop the turn** — do not answer the question yourself or continue the task until the user submits the card

### Example

```json
{
  "questions": [{
    "question": "Deleting a Derived* through Base* without a virtual destructor — what happens?",
    "options": [
      { "label": "Only ~Base() runs" },
      { "label": "Only ~Derived() runs" },
      { "label": "~Derived() then ~Base()" },
      { "label": "Compile error" },
      { "label": "Undefined behavior" }
    ]
  }]
}
```

User reply arrives as `[我的选择]` followed by numbered answers — treat that as authoritative.
