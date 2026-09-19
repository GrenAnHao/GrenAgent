// diagnostics: run the project's configured check commands (tsc/eslint) and
// return structured {file,line,severity,message} diagnostics. Pure extension.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { resolveCommands } from "./config.js";
import { type Diagnostic, parseEslintJson, parseTsc } from "./parsers.js";
import { runChecks } from "./runner.js";

const enabled = () => (getConfig("DIAGNOSTICS_ENABLED") ?? "1") !== "0";
const timeoutMs = () => Number(getConfig("DIAGNOSTICS_TIMEOUT_MS") ?? "120000") || 120000;

function parse(source: string, stdout: string, stderr: string): Diagnostic[] {
  if (source === "eslint") return parseEslintJson(stdout || stderr);
  return parseTsc(`${stdout}\n${stderr}`);
}

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;

  pi.registerTool({
    name: "diagnostics",
    label: "Diagnostics",
    description:
      "Run the project's type-check / lint commands (tsc/eslint) and return structured {file,line,severity,message} " +
      "diagnostics. Configure via diagnostics.commands in .pi/settings.json, or rely on tsconfig.json/eslint auto-detect.",
    promptSnippet: "Run project type-check/lint and return structured diagnostics.",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String(), { description: "Optional path substrings to filter results" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const commands = resolveCommands(ctx.cwd);
      if (!commands.length) {
        return {
          content: [
            {
              type: "text",
              text: "No check commands. Add diagnostics.commands to .pi/settings.json, or add tsconfig.json / an eslint config.",
            },
          ],
          details: { diagnostics: [] },
        };
      }
      const raws = await runChecks(ctx.cwd, commands, signal ?? undefined, timeoutMs());
      let diags = raws.flatMap((r) => parse(r.source, r.stdout, r.stderr));
      const paths = params.paths;
      if (paths?.length) {
        diags = diags.filter((d) => paths.some((p) => d.file.replace(/\\/g, "/").includes(p)));
      }
      if (!diags.length) {
        return {
          content: [{ type: "text", text: `No diagnostics. (ran: ${commands.map((c) => c.join(" ")).join("; ")})` }],
          details: { diagnostics: [] },
        };
      }
      const body = diags
        .slice(0, 200)
        .map((d) => `${d.severity.toUpperCase()} ${d.file}:${d.line}${d.col ? `:${d.col}` : ""} [${d.source}] ${d.message}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `${diags.length} diagnostic(s):\n${body}` }],
        details: { diagnostics: diags },
      };
    },
  });
}
