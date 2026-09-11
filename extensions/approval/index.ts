// approval：审批策略（ask/auto/full）的热更新应用 + 状态回推。
// 策略本体在 _shared/approval（进程内共享），供 safety / 沙箱消费者读取。
// 桌面切换走宿主 agent_set_approval：先写进程内内存（对话中下一刀现读），再落盘。
// session_start / watchConfig 只负责从文件灌内存。不再注册 /approval。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ApprovalPolicy,
  approvalPolicyConfigKey,
  getApprovalPolicy,
  hasApprovalPolicy,
  parseApproval,
  setApprovalPolicy,
} from "../_shared/approval.js";
import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import { currentCwd } from "../_shared/workspace-context.js";

interface PersistedState {
  policy?: ApprovalPolicy;
}

export default function (pi: ExtensionAPI) {
  let workspaceCwd: string | undefined;
  const cwd = (): string => workspaceCwd ?? currentCwd();

  const push = (ctx: ExtensionContext) => ctx.ui.setStatus("approval-policy", getApprovalPolicy(workspaceCwd));

  watchConfig((next) => {
    const nextPolicy = parseApproval(next[approvalPolicyConfigKey(cwd())]);
    if (!nextPolicy || nextPolicy === getApprovalPolicy(cwd())) return;
    setApprovalPolicy(nextPolicy, cwd());
  });

  pi.on("session_start", async (_event, ctx) => {
    workspaceCwd = ctx.cwd;
    const entries = ctx.sessionManager.getEntries() as Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "approval").pop();
    const data = entry?.data as PersistedState | undefined;
    if (!hasApprovalPolicy(ctx.cwd)) {
      setApprovalPolicy(
        parseApproval(getConfig(approvalPolicyConfigKey(cwd()))) ??
          parseApproval(getConfig("APPROVAL_POLICY")) ??
          parseApproval(data?.policy) ??
          "auto",
        ctx.cwd,
      );
    }
    push(ctx);
  });
}
