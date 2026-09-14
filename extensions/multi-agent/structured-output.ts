import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export const STRUCTURED_OUTPUT_INSTRUCTION =
  `得出最终答案后，必须调用 ${STRUCTURED_OUTPUT_TOOL} 工具、参数严格符合其 schema 来交付结果。` +
  "不要以纯文本收尾：只有这次工具调用算作你的结果。";

export interface StructuredCapture {
  factory: (pi: ExtensionAPI) => void;
  captured: () => { value: unknown } | undefined;
}

export function createStructuredCapture(schema: object): StructuredCapture {
  let captured: { value: unknown } | undefined;
  return {
    captured: () => captured,
    factory: (pi) => {
      pi.registerTool({
        name: STRUCTURED_OUTPUT_TOOL,
        label: "Structured Output",
        description: "Deliver your final result. Call exactly once with arguments matching the schema.",
        parameters: schema as never,
        async execute(_id, params) {
          const replaced = captured !== undefined;
          captured = { value: params };
          return { content: [{ type: "text", text: replaced ? "结果已替换先前记录" : "结果已记录" }], details: {} };
        },
      });
    },
  };
}

export function withStructuredInstruction(systemPrompt: string | undefined): string {
  const head = systemPrompt?.trim() ?? "";
  return head ? `${head}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION;
}
