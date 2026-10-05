import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { requestResourceReload } from "../_shared/resource-reload.js";
import { reconcileMcpManager } from "../mcp/manager.js";
import { probeServer } from "../mcp/probe.js";
import { installSkill, prepareSkill, commitPreparedSkill, discardPreparedSkill } from "./skill-store.js";
import { writeMcpServer } from "./mcp-store.js";
import { normalizeMcpInput, publicMcpView, redactSecrets, type AddMcpServerInput, type AddSkillInput } from "./validation.js";

function result(text: string, details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } { return { content: [{ type: "text", text }], details }; }
function confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean> { return ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false); }
// 根 schema 必须是 type:object。anyOf 联合会被 DeepSeek 等接口拒成 type:null。
const mcpParams = Type.Object({
  name: Type.String(),
  scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
  transport: Type.Union([
    Type.Literal("stdio"),
    Type.Literal("remote"),
    Type.Literal("http"),
    Type.Literal("sse"),
  ]),
  command: Type.Optional(Type.String({ description: "Required for stdio. Omit for remote." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "stdio only" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "stdio only" })),
  cwd: Type.Optional(Type.String({ description: "stdio only" })),
  url: Type.Optional(Type.String({ description: "Required for remote, http, or sse." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Remote request headers, including Authorization." })),
  replace: Type.Optional(Type.Boolean()),
});
const skillParams = Type.Object({
  name: Type.String(), source: Type.Union([
    Type.Object({ type: Type.Literal("content"), content: Type.String() }),
    Type.Object({ type: Type.Literal("file"), path: Type.String() }),
    Type.Object({ type: Type.Literal("directory"), path: Type.String() }),
  ]), description: Type.Optional(Type.String()), replace: Type.Optional(Type.Boolean()),
});

const resourceGuideline = [
  "当用户要求添加、安装或配置 MCP server 时，必须调用 add_mcp_server；不要使用 write、edit 或 bash 手动修改 mcp.json。",
  "当用户要求添加或安装 Skill 时，必须调用 add_skill；不要使用 write、edit 或 bash 手动创建 ~/.agents/skills 下的文件。",
];
const mcpGuideline = [
  ...resourceGuideline,
  "Use add_mcp_server with transport \"remote\", url, and headers when the user gives a remote MCP. Do not pass command, args, env, or cwd for that call. Put Authorization in headers.",
];

export default function resourceManager(pi: ExtensionAPI) {
  pi.registerTool({
    name: "add_mcp_server", label: "Add MCP server",
    description: "Add an MCP server. Local servers use transport stdio plus command. Remote servers use transport remote plus url and headers only; do not send command, args, env, or cwd. The URL path selects SSE or Streamable HTTP.",
    promptSnippet: "添加 MCP server（remote 只写 url 与 headers；确认后写入分层配置）",
    promptGuidelines: mcpGuideline,
    parameters: mcpParams,
    async execute(_id, raw, _signal, _update, ctx) {
      const rawInput = raw as AddMcpServerInput;
      const normalized = normalizeMcpInput(rawInput);
      if (!normalized.ok) {
        const error = normalized.error;
        return result(error, { status: "error", resource: "mcp", error, parsed: publicMcpView(rawInput), response: error });
      }
      const input = normalized.value.input;
      const ignored = normalized.value.ignored;
      const parsed = publicMcpView(input, ignored, rawInput);
      if (!ctx.hasUI) return result("添加 MCP 需要交互确认", { status: "error", resource: "mcp", error: "交互确认不可用", parsed, response: "添加 MCP 需要交互确认" });
      const envKeys = Object.keys(input.env ?? {});
      const headerKeys = Object.keys(input.headers ?? {});
      const summary = input.transport === "stdio"
        ? "命令: " + [input.command, ...(input.args ?? [])].join(" ") + "\n环境变量: " + (envKeys.join(", ") || "无")
        : "传输: " + input.transport + "\nURL: " + input.url + "\n请求头: " + (headerKeys.join(", ") || "无");
      const ignoredNote = ignored.length ? "\n已忽略（remote 不写入）: " + ignored.join(", ") : "";
      const ok = await confirm(ctx, "确认添加 MCP", "作用域: " + input.scope + "\n" + summary + ignoredNote);
      if (!ok) return result("用户取消添加 MCP", { status: "cancelled", resource: "mcp", parsed, response: "用户取消添加 MCP" });
      const secrets = [...Object.values(input.env ?? {}), ...Object.values(input.headers ?? {})];
      try {
        ctx.ui.notify("正在探测 MCP server…");
        const transport = input.transport === "sse" ? "sse" : input.transport === "stdio" ? "stdio" : "http";
        const probe = await probeServer({ name: input.name, transport, command: input.command, args: input.args, env: input.env, cwd: input.cwd, url: input.url, headers: input.headers });
        if (!probe.ok) {
          const error = redactSecrets(probe.error ?? "unknown error", secrets);
          ctx.ui.notify("MCP 探测失败: " + error, "error");
          return result("MCP 探测失败: " + error, { status: "error", resource: "mcp", error, parsed, response: "MCP 探测失败: " + error });
        }
        const path = await writeMcpServer(input, ctx.cwd, undefined, getConfig("MCP_SERVERS") ?? "");
        reconcileMcpManager(currentWorkspaceContext()?.workspace ?? ctx.cwd);
        ctx.ui.notify("MCP " + input.name + " 已添加");
        const response = "已添加 MCP " + input.name;
        return result(response, { status: "saved", resource: "mcp", name: input.name, scope: input.scope, path, connection: "connected", tools: probe.toolNames, parsed, response });
      } catch (e) {
        const message = redactSecrets(e instanceof Error ? e.message : String(e), secrets);
        ctx.ui.notify("添加 MCP 失败: " + message, "error");
        return result("添加 MCP 失败: " + message, { status: "error", resource: "mcp", error: message, parsed, response: "添加 MCP 失败: " + message });
      }
    },
  });
  pi.registerTool({
    name: "add_skill", label: "Add Skill",
    description: "Install a Skill through the managed skill store. Use this whenever the user asks to add or install a Skill; never create ~/.agents/skills files manually.",
    promptSnippet: "安装 Skill（确认后写入托管目录）",
    promptGuidelines: resourceGuideline,
    parameters: skillParams,
    async execute(_id, raw, _signal, _update, ctx) {
      const input = raw as AddSkillInput;
      if (!ctx.hasUI) return result("添加 Skill 需要交互确认", { status: "error", resource: "skill", error: "交互确认不可用" });
      let prepared;
      try { prepared = await prepareSkill(input); } catch (e) { const error = e instanceof Error ? e.message : String(e); return result("准备 Skill 失败: " + error, { status: "error", resource: "skill", error }); }
      const source = input.source.type === "content" ? "内联内容" : input.source.type + ": " + input.source.path;
      const ok = await confirm(ctx, "确认添加 Skill", "名称: " + input.name + "\n来源: " + source + "\n文件数: " + prepared.files);
      if (!ok) { await discardPreparedSkill(prepared); return result("用户取消添加 Skill", { status: "cancelled", resource: "skill" }); }
      try { const installed = await commitPreparedSkill(prepared, input.replace === true); const reloadScheduled = requestResourceReload(); return result("已安装 Skill " + input.name, { status: "installed", resource: "skill", ...installed, reloadScheduled }); }
      catch (e) { await discardPreparedSkill(prepared); const error = e instanceof Error ? e.message : String(e); return result("安装 Skill 失败: " + error, { status: "error", resource: "skill", error }); }
    },
  });
}
