// approval：审批策略（readonly/ask/auto/workspace/full）按会话生效 + 状态回推。
// 策略本体在 _shared/approval（进程内共享），供 safety / 沙箱消费者读取。
// 桌面切换走宿主 agent_set_approval：写该会话的进程内内存 + 会话条目 session-preferences，
// 不再改项目默认。session_start 把本会话的档钉进内存，之后项目默认档变化不再影响它。
// 缺档位的历史会话首次继承项目默认时把初值固化进 canonical 条目（只一次），冷恢复不再重新继承。
import { projectCwd } from "../_shared/session-cwd.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ApprovalPolicy,
  approvalPolicyConfigKey,
  getApprovalPolicy,
  getDefaultApprovalPolicy,
  hasApprovalPolicy,
  parseApproval,
  setApprovalPolicy,
} from "../_shared/approval.js";
import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import { readSessionPreferences, SESSION_PREFERENCES_ENTRY } from "../_shared/session-preferences.js";
import { currentCwd, currentSessionId } from "../_shared/workspace-context.js";

type SessionEntry = { type: string; customType?: string; data?: unknown };

/** 会话里最近一条审批档：canonical 条目与宿主写的 session-controls 一起按文件顺序取最近。 */
export function persistedApproval(entries: SessionEntry[]): ApprovalPolicy | undefined {
  return readSessionPreferences(entries).approval;
}

function legacyApproval(entries: SessionEntry[]): ApprovalPolicy | undefined {
  const entry = entries.filter((e) => e.type === "custom" && e.customType === "approval").pop();
  return parseApproval((entry?.data as { policy?: string } | undefined)?.policy);
}

export default function (pi: ExtensionAPI) {
  let workspaceCwd: string | undefined;
  let sessionId: string | undefined;
  const cwd = (): string => workspaceCwd ?? currentCwd();

  const push = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("approval-policy", getApprovalPolicy(workspaceCwd, sessionId));
    // 项目默认档：草稿输入栏显示用（新会话将继承它）。
    ctx.ui.setStatus("approval-policy-default", getDefaultApprovalPolicy(workspaceCwd));
  };

  /**
   * 缺档位的会话首次继承时固化初值。写失败只记日志：内存已钉住，不能让整个 session_start 抛错。
   */
  const solidifyInitialApproval = (policy: ApprovalPolicy) => {
    try {
      pi.appendEntry(SESSION_PREFERENCES_ENTRY, { approval: policy, revision: 1 });
    } catch (err) {
      console.error("[approval] 固化初始档位失败（仅内存生效）：", err);
    }
  };

  // 盘上的项目默认档变了：只灌项目默认，不碰已钉住档位的会话。
  // 每个会话（含子代理）各订一份，会话结束必须退订，否则越积越多、还会作用在已销毁的会话上。
  const unwatch = watchConfig((next) => {
    const nextPolicy = parseApproval(next[approvalPolicyConfigKey(cwd())]);
    if (!nextPolicy || nextPolicy === getDefaultApprovalPolicy(cwd())) return;
    setApprovalPolicy(nextPolicy, cwd());
  });
  pi.on("session_shutdown", () => { unwatch(); });

  pi.on("session_start", async (_event, ctx) => {
    workspaceCwd = projectCwd(ctx);
    sessionId = ctx.sessionManager.getSessionId?.() || undefined;
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    if (!hasApprovalPolicy(projectCwd(ctx))) {
      setApprovalPolicy(
        parseApproval(getConfig(approvalPolicyConfigKey(cwd()))) ??
          parseApproval(getConfig("APPROVAL_POLICY")) ??
          // 无会话身份（旧 worker / 测试桩）时沿用旧行为：会话条目兜底项目档。
          (sessionId ? undefined : legacyApproval(entries)) ??
          "auto",
        projectCwd(ctx),
      );
    }
    if (sessionId && !hasApprovalPolicy(projectCwd(ctx), sessionId)) {
      // 会话自己记的档优先；没有时继承 ALS 里的父会话（子代理），再退项目默认。
      const parent = currentSessionId();
      const inherited = parent && parent !== sessionId && hasApprovalPolicy(projectCwd(ctx), parent)
        ? getApprovalPolicy(projectCwd(ctx), parent)
        : undefined;
      const own = persistedApproval(entries);
      const initial = own ?? inherited ?? getDefaultApprovalPolicy(projectCwd(ctx));
      setApprovalPolicy(initial, projectCwd(ctx), sessionId);
      if (!own) solidifyInitialApproval(initial);
    }
    push(ctx);
  });
}
