// context-rules：每轮把启用的规则文件追加到 systemPromptOptions.contextFiles，和 AGENTS.md 同一段。
// 规则不变时系统提示也不变，不打掉前缀缓存。和 rulebook（工具拦截 / 跑偏纠正）是两回事。
//
// 规则可带 frontmatter `modes`：只在列出的模式下注入；没有 modes 的旧规则适用所有模式。
// 过滤用真实的当前会话模式（agent-mode 的 live 表，按 ALS 会话 id 查），不看会话条目里可能过期的模式。
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentMode } from "../agent-mode/modes.js";
import { projectCwd } from "../_shared/session-cwd.js";
import { currentSessionId } from "../_shared/workspace-context.js";
import { activeRuleContextFiles, createRuleCache, globalRulesDir, projectRulesDir } from "./rules.js";

export default function (pi: ExtensionAPI) {
  const cache = createRuleCache((rule) => console.error(`[context-rules] 跳过 ${rule.path}：${rule.error}`));
  // 只清理本扩展实际注入过的路径，避免误删其它来源的 rules/AGENTS.md 等上下文。
  const injectedPaths = new Set<string>();

  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    // SDK 身份优先，直接 SDK/CLI 或子会话未携带 ALS 身份时也按自身模式过滤。
    const sessionId = ctx.sessionManager?.getSessionId?.() || currentSessionId();
    const mode = getAgentMode(projectCwd(ctx), sessionId);
    const rules = cache.load([
      { dir: globalRulesDir(getAgentDir()), scope: "global" },
      { dir: projectRulesDir(ctx.cwd), scope: "project" },
    ]);
    // 当前目录实际发现的规则也归本扩展管理；重载工厂后仍能移除上次模式的条目。
    for (const rule of rules) injectedPaths.add(rule.path);
    const files = activeRuleContextFiles(rules, mode);
    // 先去掉上一次调用追加的规则条目（同一个 options 对象被复用时，切模式不能残留旧范围的规则）。
    const current = options.contextFiles ?? [];
    const base = current.filter((file) => !injectedPaths.has(file.path));
    if (files.length === 0) {
      if (base.length !== current.length) options.contextFiles = base;
      return;
    }
    const next = [...base, ...files];
    // 内容与顺序都没变时不重建数组，保持前缀缓存命中。
    const unchanged = next.length === current.length && next.every((file, i) => file === current[i]);
    if (!unchanged) options.contextFiles = next;
  });
}
