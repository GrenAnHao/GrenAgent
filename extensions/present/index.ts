import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { presentFiles } from "./present.js";

const PresentParams = Type.Object({
  files: Type.Array(Type.Object({
    path: Type.String({ description: "Path of an existing regular file. Relative paths use the session working directory; absolute paths may name files outside it." }),
    description: Type.Optional(Type.String({ description: "Short note about this deliverable" })),
  })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "present",
    label: "Present",
    description:
      "Declare existing files as this turn's deliverables. Call present after the files are written and before the final reply whenever the user should receive artifacts. Listing paths in the reply is not delivery. Every path must already exist as a regular file; relative paths use the session working directory and absolute paths may name files outside it. The user opens the current file; its contents are not copied.",
    ...toolPrompt("Declare existing files as this turn's deliverables.", [
      "Use present after writing user-facing deliverables and before the final reply; listing paths in the reply is not delivery.",
      "Use present only for files that already exist as regular files; pass an absolute path for files written outside the session working directory.",
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
