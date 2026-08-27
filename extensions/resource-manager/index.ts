import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { requestResourceReload } from "../_shared/resource-reload.js";
import { probeServer } from "../mcp/probe.js";
import { installSkill, prepareSkill, commitPreparedSkill, discardPreparedSkill } from "./skill-store.js";
import { writeMcpServer } from "./mcp-store.js";
import { redactSecrets, validateMcpInput, type AddMcpServerInput, type AddSkillInput } from "./validation.js";

function result(text: string, details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } { return { content: [{ type: "text", text }], details }; }
function confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean> { return ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false); }
const mcpParams = Type.Object({
  name: Type.String(), scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
  transport: Type.Union([Type.Literal("stdio"), Type.Literal("sse")]),
  command: Type.Optional(Type.String()), args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())), cwd: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()), replace: Type.Optional(Type.Boolean()),
});
const skillParams = Type.Object({
  name: Type.String(), source: Type.Union([
    Type.Object({ type: Type.Literal("content"), content: Type.String() }),
    Type.Object({ type: Type.Literal("file"), path: Type.String() }),
    Type.Object({ type: Type.Literal("directory"), path: Type.String() }),
  ]), description: Type.Optional(Type.String()), replace: Type.Optional(Type.Boolean()),
});

export default function resourceManager(pi: ExtensionAPI) {
  pi.registerTool({
    name: "add_mcp_server", label: "Add MCP server",
    description: "Add a local MCP server configuration after mandatory user confirmation.",
    parameters: mcpParams,
    async execute(_id, raw, _signal, _update, ctx) {
      const input = raw as AddMcpServerInput;
      const error = validateMcpInput(input);
      if (error) return result(error, { status: "error", resource: "mcp", error });
      if (!ctx.hasUI) return result("添加 MCP 需要交互确认", { status: "error", resource: "mcp", error: "交互确认不可用" });
      const envKeys = Object.keys(input.env ?? {});
      const summary = input.transport === "sse" ? "URL: " + input.url : "命令: " + [input.command, ...(input.args ?? [])].join(" ");
      const ok = await confirm(ctx, "确认添加 MCP", "作用域: " + input.scope + "\n" + summary + "\n环境变量: " + (envKeys.join(", ") || "无"));
      if (!ok) return result("用户取消添加 MCP", { status: "cancelled", resource: "mcp" });
      const secrets = Object.values(input.env ?? {});
      try {
        const probe = await probeServer({ name: input.name, transport: input.transport, command: input.command, args: input.args, env: input.env, cwd: input.cwd, url: input.url });
        if (!probe.ok) return result("MCP 探测失败: " + redactSecrets(probe.error ?? "unknown error", secrets), { status: "error", resource: "mcp", error: redactSecrets(probe.error ?? "unknown error", secrets) });
        const path = await writeMcpServer(input, ctx.cwd, undefined, getConfig("MCP_SERVERS") ?? "");
        return result("已添加 MCP " + input.name, { status: "saved", resource: "mcp", name: input.name, scope: input.scope, path, connection: "connected", tools: probe.toolNames });
      } catch (e) {
        const message = redactSecrets(e instanceof Error ? e.message : String(e), secrets);
        return result("添加 MCP 失败: " + message, { status: "error", resource: "mcp", error: message });
      }
    },
  });
  pi.registerTool({
    name: "add_skill", label: "Add Skill",
    description: "Install a local Skill from content, a Markdown file, or a directory after mandatory user confirmation.",
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
