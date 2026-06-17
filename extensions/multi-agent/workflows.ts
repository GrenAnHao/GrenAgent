// Workflow slash-commands (/implement, /scout-and-plan, /implement-and-review)
// that expand to an instruction telling the main agent to run a spawn_agent
// `chain`. Also seeds a set of default named agents (scout/planner/reviewer/
// worker) into <agentDir>/agents so the workflows work out of the box.
//
// Aligned with pi's official examples/extensions/subagent (agents + prompts).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Default agents seeded only when absent. `model` is intentionally omitted so
// each inherits SUBAGENT_MODEL / the main default instead of hardcoding a
// provider the user may not have configured.
const DEFAULT_AGENTS: Record<string, string> = {
  scout: `---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
---

You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - what's here

## Key Code
Critical types, interfaces, or functions.

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.
`,
  planner: `---
name: planner
description: Creates implementation plans from context and requirements
tools: read, grep, find, ls
---

You are a planning specialist. You receive context (from a scout) and requirements, then produce a clear implementation plan.

You must NOT make any changes. Only read, analyze, and plan.

Output format:

## Goal
One sentence summary of what needs to be done.

## Plan
Numbered, small, actionable steps (specific file/function to modify).

## Files to Modify
- \`path/to/file.ts\` - what changes

## Risks
Anything to watch out for.

Keep the plan concrete. The worker agent will execute it verbatim.
`,
  reviewer: `---
name: reviewer
description: Code review specialist for quality and security analysis
tools: read, grep, find, ls, bash
---

You are a senior code reviewer. Analyze code for quality, security, and maintainability.

Bash is for read-only commands only (\`git diff\`, \`git log\`, \`git show\`). Do NOT modify files or run builds.

Output format:

## Files Reviewed
- \`path/to/file.ts\` (lines X-Y)

## Critical (must fix)
- \`file.ts:42\` - issue

## Warnings (should fix)
- \`file.ts:100\` - issue

## Suggestions (consider)
- \`file.ts:150\` - improvement

## Summary
Overall assessment in 2-3 sentences. Be specific with file paths and line numbers.
`,
  worker: `---
name: worker
description: General-purpose subagent with full capabilities, isolated context
---

You are a worker agent with full capabilities, operating in an isolated context window to handle a delegated task without polluting the main conversation.

Work autonomously to complete the assigned task. Use all available tools as needed.

Output format when finished:

## Completed
What was done.

## Files Changed
- \`path/to/file.ts\` - what changed

## Notes (if any)
Anything the main agent should know.
`,
};

function seedDefaultAgents(): void {
  try {
    const dir = join(getAgentDir(), "agents");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(DEFAULT_AGENTS)) {
      const file = join(dir, `${name}.md`);
      if (!existsSync(file)) writeFileSync(file, content, "utf8");
    }
  } catch {
    /* best-effort: missing default agents just means /implement etc. report "unknown agent" */
  }
}

interface Workflow {
  description: string;
  build: (query: string) => string;
}

const WORKFLOWS: Record<string, Workflow> = {
  implement: {
    description: "Chain scout -> planner -> worker to implement a request end-to-end",
    build: (q) =>
      [
        `Use the spawn_agent tool with a \`chain\` to implement the request below.`,
        `Pass each step's output to the next via the {previous} placeholder. Request:`,
        ``,
        q,
        ``,
        `Call spawn_agent once, e.g.:`,
        `spawn_agent({ chain: [`,
        `  { agent: "scout",   task: "Find all code relevant to: ${q}" },`,
        `  { agent: "planner", task: "Create an implementation plan for this request using the context:\\n{previous}" },`,
        `  { agent: "worker",  task: "Implement this plan:\\n{previous}" }`,
        `] })`,
      ].join("\n"),
  },
  "scout-and-plan": {
    description: "Chain scout -> planner to research and plan (no implementation)",
    build: (q) =>
      [
        `Use the spawn_agent tool with a \`chain\` to research and plan the request below (do NOT implement).`,
        `Pass output between steps via {previous}. Request:`,
        ``,
        q,
        ``,
        `spawn_agent({ chain: [`,
        `  { agent: "scout",   task: "Find all code relevant to: ${q}" },`,
        `  { agent: "planner", task: "Create an implementation plan for this request using the context:\\n{previous}" }`,
        `] })`,
      ].join("\n"),
  },
  "implement-and-review": {
    description: "Chain worker -> reviewer -> worker to implement, review, then apply feedback",
    build: (q) =>
      [
        `Use the spawn_agent tool with a \`chain\` to implement, review, then apply feedback for the request below.`,
        `Pass output between steps via {previous}. Request:`,
        ``,
        q,
        ``,
        `spawn_agent({ chain: [`,
        `  { agent: "worker",   task: "Implement: ${q}" },`,
        `  { agent: "reviewer", task: "Review the implementation from the previous step:\\n{previous}" },`,
        `  { agent: "worker",   task: "Apply the review feedback:\\n{previous}" }`,
        `] })`,
      ].join("\n"),
  },
};

/** Register the workflow slash-commands and seed default agents. No-op inside sub-agents. */
export function registerWorkflows(pi: ExtensionAPI): void {
  if (process.env.PI_IS_SUBAGENT === "1") return; // sub-agents don't use slash commands
  seedDefaultAgents();
  for (const [name, wf] of Object.entries(WORKFLOWS)) {
    pi.registerCommand(name, {
      description: wf.description,
      handler: async (args, ctx) => {
        const query = args.trim();
        if (!query) {
          ctx.ui.notify(`Usage: /${name} <request>`, "warning");
          return;
        }
        if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
          ctx.ui.notify("Agent is busy — try again once it's idle.", "warning");
          return;
        }
        pi.sendUserMessage(wf.build(query));
      },
    });
  }
}
