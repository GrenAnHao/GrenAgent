import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { buildFableBehaviorPrompt, readTier3Module, resolveAgentModeFromEntries } from "./loader.js";
import { seedFableAgents } from "./seed.js";

const enabled = () => (getConfig("FABLE_BEHAVIOR") ?? "1") !== "0";
const tier2 = () => (getConfig("FABLE_BEHAVIOR_TIER2") ?? "1") !== "0";
const tier2P1 = () => (getConfig("FABLE_BEHAVIOR_TIER2_P1") ?? "1") !== "0";
const tier3 = () => (getConfig("FABLE_BEHAVIOR_TIER3_GUIDELINES") ?? "1") !== "0";
const tier3Tool = () => (getConfig("FABLE_BEHAVIOR_TIER3_TOOL") ?? "1") !== "0";

const RefParams = Type.Object({
  topic: StringEnum([
    "search-full",
    "copyright",
    "wellbeing",
    "evenhandedness",
    "citing-code",
    "frontend-design",
  ] as const),
});

export default function (pi: ExtensionAPI) {
  console.error("[fable-behavior] extension loaded");

  pi.on("session_start", async () => {
    seedFableAgents();
  });

  if (tier3Tool()) {
    pi.registerTool({
      name: "fable_behavior_ref",
      label: "Fable behavior reference",
      description:
        "Fetch full Tier-3 behavior reference text (search, copyright, code citations, frontend design, etc.).",
      promptGuidelines: [
        "Tier-3 one-line summaries are already in context; call fable_behavior_ref when you need the full reference (e.g. exact code citation fence format or copyright limits).",
      ],
      parameters: RefParams,
      async execute(_id, params) {
        const text = readTier3Module(params.topic);
        if (!text) {
          return {
            content: [{ type: "text", text: `Unknown topic: ${params.topic}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text }] };
      },
    });
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!enabled()) return undefined;

    const entries = ctx.sessionManager.getEntries() as Array<{
      type?: string;
      customType?: string;
      data?: unknown;
    }>;
    const mode = resolveAgentModeFromEntries(entries);
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const content = buildFableBehaviorPrompt({
      tier2: tier2(),
      tier2P1: tier2P1(),
      tier3Guidelines: tier3(),
      mode,
      date,
    });

    return {
      message: {
        customType: "fable-behavior",
        content,
        display: false,
      },
    };
  });
}
