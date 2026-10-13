import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decide, parsePolicy, type Policy } from "./policy.js";
import { getApprovalPolicy } from "../_shared/approval.js";
import { canRequestApproval, requestApproval, subagentApprovalTimeoutMs } from "../_shared/approval-route.js";
import { resolveToolOrigin } from "../_shared/workspace-context.js";

const DIR = join(homedir(), ".pi");
const POLICY_PATH = join(DIR, "mcp-policy.json");
const AUDIT_PATH = join(DIR, "mcp-audit.jsonl");

const EMPTY: Policy = { version: 1, defaultPermission: "auto", tools: {}, audit: { enabled: true } };

// mtime cache so the hook re-reads only when the file actually changed (front-end
// edits in phase 2 are picked up on the next tool call without a restart).
let cache: { mtimeMs: number; data: Policy } | undefined;

function loadPolicy(): Policy {
  try {
    const { mtimeMs } = statSync(POLICY_PATH);
    if (cache && cache.mtimeMs === mtimeMs) return cache.data;
    const data = parsePolicy(readFileSync(POLICY_PATH, "utf8"));
    cache = { mtimeMs, data };
    return data;
  } catch {
    return EMPTY; // missing / unreadable ⇒ empty policy (everything via default)
  }
}

// "总是允许": set this tool's permission to auto, keep its existing rules, atomic write.
function writeAlwaysAllow(toolName: string): void {
  try {
    mkdirSync(DIR, { recursive: true });
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const tools: Record<string, Record<string, unknown>> =
      raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools)
        ? (raw.tools as Record<string, Record<string, unknown>>)
        : {};
    const entry: Record<string, unknown> =
      tools[toolName] && typeof tools[toolName] === "object" ? tools[toolName] : {};
    entry.permission = "auto";
    tools[toolName] = entry;
    raw.tools = tools;
    const tmp = `${POLICY_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
    renameSync(tmp, POLICY_PATH);
    cache = undefined; // force reload next time
  } catch (e) {
    console.error(`[mcp-policy] persist always-allow failed for ${toolName}: ${e instanceof Error ? e.message : e}`);
  }
}

function parseToolName(toolName: string): { server: string; tool: string } {
  const rest = toolName.slice("mcp__".length);
  const parts = rest.split("__");
  return { server: parts[0] ?? "", tool: parts.slice(1).join("__") || rest };
}

function audit(enabled: boolean, server: string, tool: string, decision: string, args: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const s = JSON.stringify(args ?? {});
    const argsDigest = s.length > 500 ? `${s.slice(0, 500)}…` : s;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), server, tool, decision, argsDigest })}\n`;
    appendFileSync(AUDIT_PATH, line, "utf8");
  } catch {
    // best-effort; never block a tool call because audit failed
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName ?? "");
    if (!toolName.startsWith("mcp__")) return undefined;

    const policy = loadPolicy();
    const args = (event.input ?? {}) as Record<string, unknown>;
    const { server, tool } = parseToolName(toolName);
    // ask / readonly 下 safety 已统一确认 mcp__*，传入避免 mcp-policy 二次弹窗（disabled/headless 仍拦）。
    const ownerPolicy = getApprovalPolicy();
    // 子代理的界面是空的：只有能经父会话问人（approval-route.ts）才算有界面，否则按 headless 拦下。
    const isSubagent = resolveToolOrigin() === "subagent";
    const childPath = isSubagent ? ctx.sessionManager.getSessionFile() : undefined;
    const routed = await canRequestApproval(childPath);
    const hasUI = isSubagent ? routed : ctx.hasUI;
    const d = decide(policy, toolName, args, hasUI, ownerPolicy === "ask" || ownerPolicy === "readonly");

    if (d.action === "pass") {
      audit(policy.audit.enabled, server, tool, "auto", args);
      return undefined;
    }
    if (d.action === "block") {
      const decision = d.code === "disabled" ? "blocked-disabled" : "blocked-headless";
      audit(policy.audit.enabled, server, tool, decision, args);
      return { block: true, reason: d.reason };
    }

    const options = d.recordable ? ["允许本次", "总是允许", "拒绝"] : ["允许本次", "拒绝"];
    const title = `MCP 工具调用审批\n\n  ${server}: ${tool}\n  参数：${d.summary}\n\n是否允许？`;
    let choice: string | undefined;
    if (routed) {
      const answer = await requestApproval(childPath, { title, options, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (answer.outcome === "timeout") {
        audit(policy.audit.enabled, server, tool, "timeout", args);
        const seconds = Math.round(subagentApprovalTimeoutMs() / 1000);
        return { block: true, reason: `${seconds} 秒内没有人批准，视为被拒` };
      }
      // 不是用户拒绝的，不能说成「用户拒绝」：卡片被关掉 / 子代理被打断，或判定之后父会话没了。
      if (answer.outcome === "cancelled") {
        audit(policy.audit.enabled, server, tool, "cancelled", args);
        return { block: true, reason: "授权请求已取消" };
      }
      if (answer.outcome === "unavailable") {
        audit(policy.audit.enabled, server, tool, "blocked-headless", args);
        return { block: true, reason: "需要审批但当前无界面（headless），已阻止" };
      }
      choice = answer.outcome === "answered" ? answer.choice : undefined;
    } else {
      choice = await ctx.ui.select(title, options);
    }
    if (choice === "总是允许") {
      writeAlwaysAllow(toolName);
      audit(policy.audit.enabled, server, tool, "always-approved", args);
      return undefined;
    }
    if (choice === "允许本次") {
      audit(policy.audit.enabled, server, tool, "approved", args);
      return undefined;
    }
    audit(policy.audit.enabled, server, tool, "rejected", args);
    return { block: true, reason: "用户拒绝执行" };
  });
}
