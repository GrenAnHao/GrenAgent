// approval：审批策略（ask/auto/full）的命令 + 持久化 + 状态回推。复刻 agent-mode 状态流。
// 策略本体存在 _shared/approval（进程内共享），供 safety / 沙箱消费者读取；本扩展负责
// 命令切换、按 session 回读/持久化、以及 setStatus 推前端供「审批」下拉回读高亮。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ApprovalPolicy,
  APPROVAL_LABELS,
  approvalPolicyConfigKey,
  getApprovalPolicy,
  parseApproval,
  setApprovalPolicy,
} from "../_shared/approval.js";
import { getConfig, setRuntimeConfig, watchConfig } from "../_shared/runtime-config.js";
import { currentCwd } from "../_shared/workspace-context.js";

interface PersistedState {
  policy?: ApprovalPolicy;
}

export default function (pi: ExtensionAPI) {
  let workspaceCwd: string | undefined;
  const cwd = (): string => workspaceCwd ?? currentCwd();

  const persist = () =>
    pi.appendEntry("approval", { policy: getApprovalPolicy(workspaceCwd) } satisfies PersistedState);
  const push = (ctx: ExtensionContext) => ctx.ui.setStatus("approval-policy", getApprovalPolicy(workspaceCwd));

  watchConfig((next) => {
    const nextPolicy = parseApproval(next[approvalPolicyConfigKey(cwd())]);
    if (!nextPolicy || nextPolicy === getApprovalPolicy(cwd())) return;
    setApprovalPolicy(nextPolicy, cwd());
  });

  pi.registerCommand("approval", {
    description: "切换审批策略：/approval ask|auto|full",
    handler: async (args, ctx) => {
      const next = parseApproval(args);
      if (!next) {
        ctx.ui.notify(`用法：/approval ask|auto|full（当前：${getApprovalPolicy(ctx.cwd)}）`, "warning");
        return;
      }
      setApprovalPolicy(next, ctx.cwd);
      setRuntimeConfig(approvalPolicyConfigKey(ctx.cwd), next);
      persist();
      push(ctx);
      ctx.ui.notify(`审批策略：${APPROVAL_LABELS[next]}`, "info");
    },
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
    setApprovalPolicy(
      parseApproval(getConfig(approvalPolicyConfigKey(cwd()))) ??
        parseApproval(getConfig("APPROVAL_POLICY")) ??
        parseApproval(data?.policy) ??
        "auto",
      ctx.cwd,
    );
    push(ctx);
  });
}
