// context-rules：每轮把启用的规则文件追加到 systemPromptOptions.contextFiles，和 AGENTS.md 同一段。
// 规则不变时系统提示也不变，不打掉前缀缓存。和 rulebook（工具拦截 / 跑偏纠正）是两回事。
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeRuleContextFiles, createRuleCache, globalRulesDir, projectRulesDir } from "./rules.js";

export default function (pi: ExtensionAPI) {
  const cache = createRuleCache((rule) => console.error(`[context-rules] 跳过 ${rule.path}：${rule.error}`));

  pi.on("before_agent_start", async (event, ctx) => {
    const files = activeRuleContextFiles(
      cache.load([
        { dir: globalRulesDir(getAgentDir()), scope: "global" },
        { dir: projectRulesDir(ctx.cwd), scope: "project" },
      ]),
    );
    if (files.length === 0) return;
    const options = event.systemPromptOptions;
    options.contextFiles = [...(options.contextFiles ?? []), ...files];
  });
}
