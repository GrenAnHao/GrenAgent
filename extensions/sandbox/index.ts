import { projectCwd } from "../_shared/session-cwd.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getAgentMode } from "../agent-mode/modes.js";
import { clearEscalationGrants } from "../_shared/sandbox/escalationGrant.js";
import { createSandboxedBashOperations } from "../_shared/sandbox/operations.js";
import { createSandboxProvider } from "../_shared/sandbox/provider.js";
import { resolvePreset } from "../_shared/sandbox/resolvePreset.js";
import { withTextMarkers } from "../_shared/sandbox/userBash.js";
import { jobs } from "../jobs/service.js";
import { createGrenBashTool } from "./bashTool.js";
import { withBashUiDescription } from "./bashUiDescription.js";
import type { SandboxGate } from "./escalation.js";
import { annotateWindowsBashTool } from "./windowsBashPrompt.js";

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

  /**
   * 一次 bash 调用起步的模式，以及审批档是否拒绝从它升权（「工作区编辑」档下的 workspace-write）。
   * 和 operations 的 getPolicy() 同源（会话 cwd）：exec 只在 PI_SANDBOX_MODE_ONCE 比它自己的模式严格更宽时才放宽，
   * 两边看的不是同一个根，用户批准的放宽可能在执行时被静默忽略。
   */
  const sandboxGate = (): SandboxGate => {
    const mode = getPolicy().mode;
    return { mode, presetBlocksEscalation: mode === "workspace-write" && getApprovalPolicy(cwd) === "workspace" };
  };

  const operations = createSandboxedBashOperations({
    getPolicy: () => getPolicy(),
    confine: (argv, policy) => provider.confine(argv, policy),
  });

  pi.on("session_start", (_event, ctx) => {
    // 可写根与审批 / 模式查询都按会话的原始目录，切到 worktree 后也不变（DSH：原始沙箱根不变）。
    cwd = projectCwd(ctx);
    sessionId = ctx.sessionManager.getSessionId();
  });

  // 自有 bash（不再用 pi 的 createBashToolDefinition）：契约照 pi 1.0.2，执行照 DSH——每次调用都是 jobs 里的 bash job，
  // 前台等到 timeout 仍在跑就转后台。进程走同一套沙箱 operations。
  // 升权并进 bash 的 sandbox_permissions + justification（DSH），没有单独的升权工具。
  pi.registerTool(
    withBashUiDescription(annotateWindowsBashTool(createGrenBashTool({ jobs, exec: operations.exec, sandboxGate }))),
  );

  // user_bash 由 pi 显示输出：沙箱事实经适配器写回文字。
  const userBashOperations = withTextMarkers(operations);
  pi.on("user_bash", () => ({ operations: userBashOperations }));

  pi.on("session_shutdown", async (_event, ctx) => {
    const id = sessionId ?? ctx.sessionManager.getSessionId();
    if (!id) return;
    try {
      await provider.dispose?.(id);
    } finally {
      clearEscalationGrants(id);
    }
  });
}
