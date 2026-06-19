import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { extractPath, isDangerousBash, isMutatingBash, isUnderCwd, matchProtectedPath, matchWriteAllowed } from "./rules.js";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import { sandboxAvailable, sandboxOn } from "../_shared/sandbox-gate.js";

const off = (v: string | undefined) => v === "0" || v?.toLowerCase() === "false";
const NET_TOOLS = new Set(["web_search", "web_fetch", "web_crawler"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const on = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

    // ① 子代理能力硬限（env 注入的 deny/readonly）——任何审批策略（含 full）都不得越过。
    //    优先 process.env（子代理收紧）而非全局 config，防被主 agent 放宽或泄漏。
    const denyTools = (process.env.SAFETY_DENY_TOOLS ?? getConfig("SAFETY_DENY_TOOLS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (denyTools.includes(event.toolName)) {
      return { block: true, reason: `能力档案禁用工具：${event.toolName}` };
    }
    const readonly = on(process.env.SAFETY_READONLY ?? getConfig("SAFETY_READONLY"));
    const writeAllow = (process.env.SAFETY_WRITE_ALLOW ?? getConfig("SAFETY_WRITE_ALLOW") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (readonly) {
      if (event.toolName === "write" || event.toolName === "edit") {
        const p = extractPath((event.input ?? {}) as Record<string, unknown>);
        if (!p || !matchWriteAllowed(p, writeAllow)) {
          return { block: true, reason: `只读模式：仅允许写 ${writeAllow.join(", ") || "(无)"}` };
        }
      }
      if (event.toolName === "bash" && isMutatingBash(String(event.input?.command ?? ""))) {
        return { block: true, reason: "只读模式：禁止会改动文件系统的命令" };
      }
    }

    // ② owner 审批策略：full 跳过余下「面向用户的确认/保护」（能力硬限已在 ① 强制）。
    const policy = getApprovalPolicy();
    if (policy === "full") return undefined;

    // ③ 沙箱激活时禁内置 bash，steer 到 sandbox_sh（隔离执行）。
    if (event.toolName === "bash" && (await sandboxOn())) {
      return {
        block: true,
        reason: "沙箱模式：内置 bash 已禁用，请改用 sandbox_sh（隔离环境执行，写限 workspace、网络默认禁）。",
      };
    }

    // ④ 请求批准（ask）：仅在有 UI 时逐次确认；headless（子代理）无法确认 → 降级为 auto 行为
    //    （不阻断，避免继承 ask 的子代理被全拦），仍受 ⑤ 危险命令/受保护路径门控。
    if (policy === "ask" && ctx.hasUI) {
      // 外部 MCP 工具（名为 mcp__server__tool，含 fetch 等）与内置联网工具 → 逐次确认。
      const isMcp = event.toolName.startsWith("mcp__");
      if (isMcp || NET_TOOLS.has(event.toolName)) {
        const choice = await ctx.ui.select(
          `请求批准：允许使用${isMcp ? "外部 MCP" : "联网"}工具？\n\n  ${event.toolName}`,
          ["允许", "拒绝"],
        );
        if (choice !== "允许") return { block: true, reason: `用户拒绝使用工具：${event.toolName}` };
      }
      if (event.toolName === "write" || event.toolName === "edit") {
        const p = extractPath((event.input ?? {}) as Record<string, unknown>);
        if (p && !isUnderCwd(p, ctx.cwd)) {
          const choice = await ctx.ui.select(`请求批准：允许写工作区外文件？\n\n  ${p}`, ["允许", "拒绝"]);
          if (choice !== "允许") return { block: true, reason: "用户拒绝越界写" };
        }
      }
      // shell 越界写缺口：沙箱可用时 bash 已被禁（③）；沙箱不可用时，会改动文件的命令需确认。
      if (event.toolName === "bash" && isMutatingBash(String(event.input?.command ?? "")) && !(await sandboxAvailable())) {
        const choice = await ctx.ui.select(
          `请求批准：允许执行会改动文件的命令？\n\n  ${String(event.input?.command ?? "")}`,
          ["允许", "拒绝"],
        );
        if (choice !== "允许") return { block: true, reason: "用户拒绝改动文件的命令" };
      }
    }

    // ⑤ 既有：危险命令确认 + 受保护路径拦写（auto 与 ask 共用）。
    const guardBash = !off(getConfig("SAFETY_BASH_CONFIRM"));
    const guardPaths = !off(getConfig("SAFETY_PROTECT_PATHS"));
    if (guardBash && event.toolName === "bash") {
      const command = String(event.input?.command ?? "");
      if (isDangerousBash(command)) {
        if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI)" };
        const choice = await ctx.ui.select(`危险命令：\n\n  ${command}\n\n是否允许？`, ["允许", "拒绝"]);
        if (choice !== "允许") return { block: true, reason: "用户拒绝执行" };
      }
    }
    if (guardPaths && (event.toolName === "write" || event.toolName === "edit")) {
      const p = extractPath((event.input ?? {}) as Record<string, unknown>);
      if (p && matchProtectedPath(p)) {
        return { block: true, reason: `受保护路径，已阻止写入：${p}` };
      }
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
