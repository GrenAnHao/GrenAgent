import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { presentFiles } from "./present.js";

const PresentParams = Type.Object({
  files: Type.Array(Type.Object({
    path: Type.String({ description: "Workspace-relative path of an existing regular file" }),
    description: Type.Optional(Type.String({ description: "Short note about this deliverable" })),
  })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "present",
    label: "Present",
    description:
      "Declare existing workspace files as this turn's deliverables. Call present after the files are written and before the final reply whenever the user should receive artifacts. Listing paths in the reply is not delivery. Every path must already exist as a regular file inside the workspace.",
    ...toolPrompt("Declare existing workspace files as this turn's deliverables.", [
      "Use present after writing user-facing deliverables and before the final reply; listing paths in the reply is not delivery.",
      "Use present only for files that already exist as regular files inside the workspace.",
    ]),
    parameters: PresentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = presentFiles(ctx.cwd, params.files);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.files.map((f) => `Presented ${f.path}`).join("\n") }],
        details: { files: result.files },
      };
    },
  });
}
