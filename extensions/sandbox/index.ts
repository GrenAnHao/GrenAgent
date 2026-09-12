import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getAgentMode } from "../agent-mode/modes.js";
import { isStrictWidening, justifyOk } from "../_shared/sandbox/escalate.js";
import { createSandboxedBashOperations } from "../_shared/sandbox/operations.js";
import { clearPendingDenials, consumePendingDenial, peekPendingDenial } from "../_shared/sandbox/pendingDenial.js";
import { createSandboxProvider } from "../_shared/sandbox/provider.js";
import { resolvePreset } from "../_shared/sandbox/resolvePreset.js";
import type { FileSandboxMode } from "../_shared/sandbox/types.js";

export default function (pi: ExtensionAPI) {
  const provider = createSandboxProvider();

  // ExtensionAPI 没有 cwd / sessionManager，只能从 ExtensionContext 写入闭包。
  // 不要退化到 process.cwd() 当可写根——多工作区会绑错 workspaceRoot。
  let cwd = "";
  let sessionId: string | undefined;

  const getPolicy = (override?: string) => {
    const root = override ?? cwd;
    return resolvePreset({
      approval: getApprovalPolicy(root),
      agentMode: getAgentMode(root),
      workspaceRoot: root,
      ...(sessionId ? { sessionId } : {}),
    });
  };

  const operations = createSandboxedBashOperations({
    getPolicy: () => getPolicy(),
    confine: (argv, policy) => provider.confine(argv, policy),
  });

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
  });

  // createBashToolDefinition 返回 ToolDefinition，才能 registerTool（createBashTool 返回 AgentTool）。
  // 包根已导出该函数，无需深导入 dist/core/tools/bash.js。构造期 cwd 只是 SDK 兜底，执行时用 ctx.cwd。
  pi.registerTool(createBashToolDefinition(cwd, { operations }));

  pi.on("user_bash", () => ({ operations }));

  pi.registerTool({
    name: "bash_escalate",
    label: "Escalate sandbox",
    description:
      "Retry the exact denied bash command under a wider file sandbox for this call only. Requires justification.",
    parameters: Type.Object({
      command: Type.String(),
      justification: Type.String(),
      targetMode: Type.Unsafe<FileSandboxMode>({ type: "string" }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const execCwd = ctx.cwd;
      const policy = getPolicy(execCwd);
      const sid = ctx.sessionManager.getSessionId() || sessionId;
      const pending = peekPendingDenial(execCwd, params.command, sid);
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
      const consume = () => consumePendingDenial(execCwd, params.command, sid);
      if (!pending) return fail("bash_escalate: no pending denial for that command.");
      if (!justifyOk(params.justification)) return fail("bash_escalate: justification must be at least 20 characters.");
      if (!isStrictWidening(pending.mode, params.targetMode)) {
        return fail("bash_escalate: targetMode is not a strict widening.");
      }
      // 按解析后的 mode 裁决，不只看审批档：Ask 会把 mode 强制成 read-only，
      // 此时即使审批档是 workspace，也应走「问人」而不是直接拒。
      if (policy.mode === "workspace-write" && getApprovalPolicy(execCwd) === "workspace") {
        consume();
        return fail("bash_escalate: workspace-edit preset rejects escalation.");
      }
      if (!ctx.hasUI) {
        consume();
        return fail("bash_escalate: UI unavailable; denied.");
      }
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(
          `Sandbox escalation\n\n${params.command}\n\n${params.justification}\n\n→ ${params.targetMode}`,
          ["允许本次", "拒绝"],
        );
      } catch {
        consume();
        return fail("bash_escalate: cancelled.");
      }
      if (choice !== "允许本次") {
        consume();
        return fail("bash_escalate: rejected.");
      }
      consume();
      const chunks: Buffer[] = [];
      const result = await operations.exec(params.command, execCwd, {
        signal,
        onData: (data) => {
          chunks.push(data);
          const text = Buffer.concat(chunks).toString();
          onUpdate?.({ content: [{ type: "text", text }], details: undefined });
        },
        env: { ...process.env, PI_SANDBOX_MODE_ONCE: params.targetMode },
      });
      const output = Buffer.concat(chunks).toString();
      const text = output || `exit ${result.exitCode ?? "null"}`;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const id = sessionId ?? ctx.sessionManager.getSessionId();
    if (!id) return;
    await provider.dispose?.(id);
    clearPendingDenials(id);
  });
}
