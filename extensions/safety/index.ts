import { resolve } from "node:path";
import { projectCwd } from "../_shared/session-cwd.js";
import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { extractPath, isDangerousBash, isMutatingBash, isUnderCwd, matchProtectedPath, matchWriteAllowed } from "./rules.js";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import {
  CODE_EXEC_TOOLS,
  NET_TOOLS as NET_TOOL_NAMES,
  WRITE_TOOLS,
} from "../_shared/tool-groups.js";
import {
  desktopControl, evaluateToolCall, rememberToolRule, resolveToolOrigin, settleToolCall,
  type ApprovalPreset, type ToolCallFacts, type ToolRuleDraft,
} from "../_shared/desktop-control.js";
import { DELEGATION_DENY_REASON, SUBAGENT_ASK_PINNED_RULE_ID } from "../_shared/delegation-scope.js";
import { canRequestApproval, requestApproval, subagentApprovalTimeoutMs } from "../_shared/approval-route.js";
import { grantEscalation } from "../_shared/sandbox/escalationGrant.js";

const off = (v: string | undefined) => v === "0" || v?.toLowerCase() === "false";
// 工具分组取自单一真相源（_shared/tool-groups），避免与 capability 能力闸各维护一份而漂移失配。
const NET_TOOLS = new Set<string>(NET_TOOL_NAMES);
const WRITE_BYPASS_TOOLS = new Set<string>(WRITE_TOOLS);
// 代码执行工具（py_run/js_run/dap_*）一律在宿主进程执行（node:vm 可逃逸 / python 子进程 / 调试器）。
const CODE_EXEC = new Set<string>(CODE_EXEC_TOOLS);

/**
 * 把一次调用压成主进程需要的事实特征。判定逻辑留在 sidecar，主进程只消费布尔量。
 *
 * 参数类型刻意声明得比 SDK 的 ToolCallEvent / Context 宽松：结构化类型让实参
 * 兼容，同时这个函数在单测里可以用普通对象调用，不必构造完整的 SDK 上下文。
 */
function collectFacts(
  event: { toolName: string; toolCallId?: string; input?: unknown },
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string | undefined; getCwd?: () => string } },
  preset: ApprovalPreset,
): ToolCallFacts {
  const input = (event.input ?? {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : undefined;
  const isWrite = event.toolName === "write" || event.toolName === "edit" || WRITE_BYPASS_TOOLS.has(event.toolName);
  const path = isWrite ? extractPath(input) : undefined;
  // SAFETY_BASH_CONFIRM / SAFETY_PROTECT_PATHS 是既有的用户开关（原第 92-93 行）。
  // 内置规则不可编辑，所以关闭护栏的能力必须留在这里：开关关掉时干脆不上报该特征，
  // 主进程也就无从匹配对应的内置规则。去掉这两个判断会让现有配置静默失效。
  const guardBash = !off(getConfig("SAFETY_BASH_CONFIRM"));
  const guardPaths = !off(getConfig("SAFETY_PROTECT_PATHS"));
  return {
    tool: event.toolName,
    workspace: projectCwd(ctx),
    origin: resolveToolOrigin(),
    preset,
    flags: {
      dangerousCommand: guardBash && command !== undefined && isDangerousBash(command),
      mutatingCommand: command !== undefined && isMutatingBash(command),
      protectedPath: guardPaths && path !== undefined && matchProtectedPath(path),
      // 相对路径按当前目录解析，是否越界按原始工作区判断（切到 worktree 后写回原工作区不算越界）。
      outsideWorkspace: path !== undefined && !isUnderCwd(resolve(ctx.cwd, path), projectCwd(ctx)),
      network: NET_TOOLS.has(event.toolName),
      mcp: event.toolName.startsWith("mcp__"),
      codeExec: CODE_EXEC.has(event.toolName),
      write: isWrite,
    },
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    ...(ctx.sessionManager?.getSessionId?.() === undefined
      ? {}
      : { sessionId: ctx.sessionManager.getSessionId() as string }),
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { path }),
    rawArgs: input,
  };
}

/** 子代理被拦后的去向提示：不 terminate，模型据此换路或在最终答复里交代缺口。 */
const SUBAGENT_REFUSE_HINT = "这一步没有执行。不要原样重试，换不受限的办法继续；做不到就在最终答复里说明这一步没做。";

/**
 * 硬拒绝。主会话 block 且 terminate：本批工具结束后不再自动续一轮，由用户决定下一步。
 * 子代理没有用户可交还：terminate 会让它停在 toolUse 上、没有最终答复，父代理只拿到
 * `sub-agent failed (exit 1): (no output)`，整段已做的工作作废。子代理里只 block，把原因交给模型。
 */
function refuse(reason: string) {
  if (resolveToolOrigin() === "subagent") {
    return { block: true as const, reason: `${reason}。${SUBAGENT_REFUSE_HINT}` };
  }
  return { block: true as const, reason, terminate: true as const };
}

/** bash 带升权参数时的目标模式和理由，写进询问文字；bash 工具执行前还会自己校验一遍。 */
function escalationOf(event: { toolName: string; input?: unknown }): { mode: string; justification: string } | undefined {
  if (event.toolName !== "bash") return undefined;
  const input = (event.input ?? {}) as Record<string, unknown>;
  const mode = input.sandbox_permissions;
  const justification = input.justification;
  // 和 bash 的 readEscalationArgs 一样要求理由非空：否则用户会批准一个理由为空、bash 一定会拒的请求。
  if (typeof mode !== "string" || typeof justification !== "string" || !justification.trim()) return undefined;
  return { mode, justification: justification.trim() };
}

/** 「总是允许」写成尽可能窄的规则：bash 按命令前缀，写类工具按目录，其余按工具名。 */
function draftRule(facts: ToolCallFacts): ToolRuleDraft {
  const base = { scope: "workspace" as const, scopeKey: facts.workspace, tool: facts.tool, effect: "allow" as const };
  if (facts.command !== undefined) {
    const head = facts.command.trimStart().split(/\s+/).slice(0, 2).join(" ");
    return { ...base, matcherKind: "command_prefix", matcher: head };
  }
  if (facts.path !== undefined) {
    const dir = facts.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    return { ...base, matcherKind: "path_glob", matcher: `${dir}/**` };
  }
  return { ...base, matcherKind: "any", matcher: "" };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const on = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

    // ① 子代理能力硬限（deny/readonly）——任何审批策略（含 full）都不得越过。
    //    只读会话配置（getConfig：ALS → 运行时配置文件 → process.env）。原来先读 process.env，
    //    agent-host 进程里一旦设了 SAFETY_* 就会压过所有会话；worker 子代理的限制改由派生配置文件带过去。
    const denyTools = (getConfig("SAFETY_DENY_TOOLS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (denyTools.includes(event.toolName)) {
      return refuse(`能力档案禁用工具：${event.toolName}`);
    }
    const readonly = on(getConfig("SAFETY_READONLY"));
    const writeAllow = (getConfig("SAFETY_WRITE_ALLOW") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (readonly) {
      // ast_edit/hl_edit 直接 writeFileSync 写盘，不经下面的 write/edit 白名单检查 → 只读下直接禁，
      // 否则 fs 隔离（reviewer/explore 子代理、im-platforms 受限会话）可被它们绕过。
      if (WRITE_BYPASS_TOOLS.has(event.toolName)) {
        return refuse(`只读模式：禁止 ${event.toolName}（绕过写白名单的写盘工具）`);
      }
      if (event.toolName === "write" || event.toolName === "edit") {
        const p = extractPath((event.input ?? {}) as Record<string, unknown>);
        if (!p || !matchWriteAllowed(p, writeAllow)) {
          return refuse(`只读模式：仅允许写 ${writeAllow.join(", ") || "(无)"}`);
        }
      }
      if (event.toolName === "bash" && isMutatingBash(String(event.input?.command ?? ""))) {
        return refuse("只读模式：禁止会改动文件系统的命令");
      }
    }

    // ②③④ 授权决策统一交给主进程：规则匹配、内置护栏与审计都在那边，
    // 这里只负责提取事实与执行结果。第 ① 层的能力硬限已在上方强制，不受此影响。
    const preset = getApprovalPolicy();
    const control = desktopControl();
    // 子代理没有自己的界面：能经父会话问人时（approval-route.ts）告诉主进程，ask 不再固定为拒绝。
    const childPath = resolveToolOrigin() === "subagent" ? ctx.sessionManager?.getSessionFile?.() : undefined;
    const routed = await canRequestApproval(childPath);
    const facts = { ...collectFacts(event, ctx, preset), ...(routed ? { approvalRoute: true } : {}) };
    const verdict = await evaluateToolCall(control, facts);

    if (verdict.decision === "allow") return undefined;
    if (verdict.unavailable) {
      // 通道超时不是规则拒绝：照样不执行，但不 terminate。terminate 会让这轮停在 toolUse 上、没有正文，
      // 子代理因此以 "(no output)" 出错退出。模型拿到这条结果可以重试或换路。
      return { block: true, reason: `授权服务暂时没有响应，${event.toolName} 未执行，稍后可以重试这一步。` };
    }
    if (verdict.decision === "deny") {
      if (verdict.ruleId === SUBAGENT_ASK_PINNED_RULE_ID) return { block: true, reason: DELEGATION_DENY_REASON };
      return refuse(`已被授权规则拒绝：${event.toolName}`);
    }

    // ask：无 UI 时不能就地询问，审计行保持 queued 等人处理。
    if (!routed && !ctx.hasUI) {
      return { block: true, reason: `已攒起等待授权：${event.toolName}` };
    }

    const detail = facts.command ?? facts.path ?? event.toolName;
    // 带升权的 bash：同一次询问里写明目标模式和理由，允许后给这次调用留一张许可，bash 不再问第二次。
    const escalation = escalationOf(event);
    const question = escalation
      ? `${detail}\n\n  沙箱升权 → ${escalation.mode}\n  理由：${escalation.justification}`
      : detail;
    // 带升权的询问不给「总是允许」：它只会记命令规则，用户却会以为是对升权的长期授权。
    const options = escalation ? ["允许本次", "拒绝"] : ["允许本次", "总是允许", "拒绝"];
    const title = `请求批准：\n\n  ${question}`;
    let choice: string | undefined;
    if (routed) {
      // 子代理：经父会话的界面问人，最多等 SUBAGENT_APPROVAL_TIMEOUT_MS，从发出请求算起。
      const answer = await requestApproval(childPath, { title, options, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (answer.outcome === "timeout") {
        await settleToolCall(control, verdict.auditId, "timeout");
        const seconds = Math.round(subagentApprovalTimeoutMs() / 1000);
        return refuse(`${seconds} 秒内没有人批准 ${event.toolName}，视为被拒`);
      }
      if (answer.outcome === "unavailable") {
        // 判定之后父会话没了：和没有路由一样，按委派范围拒绝。
        await settleToolCall(control, verdict.auditId, "aborted");
        return { block: true, reason: DELEGATION_DENY_REASON };
      }
      choice = answer.outcome === "answered" ? answer.choice : undefined;
    } else {
      try {
        // 0.85+：用户取消 select 返回 undefined，不再保证抛错。
        choice = await ctx.ui.select(title, options);
      } catch {
        await settleToolCall(control, verdict.auditId, "aborted");
        return refuse("授权请求已取消");
      }
    }
    if (choice == null) {
      await settleToolCall(control, verdict.auditId, "aborted");
      return refuse("授权请求已取消");
    }

    if (choice === "拒绝") {
      await settleToolCall(control, verdict.auditId, "user_deny");
      return refuse(`用户拒绝：${event.toolName}`);
    }
    if (choice === "总是允许") await rememberToolRule(control, draftRule(facts));
    await settleToolCall(control, verdict.auditId, "user_allow");
    // 许可只给这一次调用，以后的升权仍由 bash 自己问。
    if (escalation && event.toolCallId !== undefined) {
      grantEscalation(ctx.sessionManager?.getSessionId?.() ?? "", event.toolCallId, escalation.mode);
    }
    return undefined;
  });

  // project_trust 必须返回 { trusted: "yes"|"no"|"undecided" }（官方 ProjectTrustEventResult），不是 block。
  // ctx 为特化 ProjectTrustContext：仅 cwd/mode/hasUI + ui.{select,confirm,input,notify}。
  pi.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
    if (getApprovalPolicy() === "full") return { trusted: "yes", remember: true };
    if (!ctx.hasUI) return { trusted: "undecided" };
    const ok = await ctx.ui.confirm("项目信任", `信任此工作区并允许写入/执行命令？\n${event.cwd}`);
    return ok ? { trusted: "yes", remember: true } : { trusted: "no" };
  });
}
