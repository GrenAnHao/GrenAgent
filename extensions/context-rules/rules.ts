// 规则文件：全局 <agentDir>/rules/*.md，项目 <cwd>/.pi/rules/*.md。一条一个文件，frontmatter 有 title 和 enabled，
// 可选 modes（适用的 AgentMode 列表；缺省或空 = 所有模式）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENT_MODES, type AgentMode } from "../agent-mode/modes.js";

export type RuleScope = "global" | "project";

export interface RuleFile {
  id: string;
  scope: RuleScope;
  path: string;
  title: string;
  enabled: boolean;
  body: string;
  /** 适用模式；undefined = 所有模式（旧规则文件即此情形）。 */
  modes?: AgentMode[];
  error?: string;
}

export function globalRulesDir(agentDir: string): string {
  return join(agentDir, "rules");
}

export function projectRulesDir(cwd: string): string {
  return join(cwd, ".pi", "rules");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseRule(id: string, scope: RuleScope, path: string, content: string): RuleFile {
  try {
    const { frontmatter, body } = parseFrontmatter<{ title?: unknown; enabled?: unknown; modes?: unknown }>(content);
    const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : id;
    const modes = normalizeRuleModes(frontmatter.modes);
    return { id, scope, path, title, enabled: frontmatter.enabled !== false, body, modes };
  } catch (error) {
    return { id, scope, path, title: id, enabled: false, body: "", error: errorText(error) };
  }
}

/**
 * modes 兼容三种写法：YAML 数组、逗号分隔字符串、单个字符串。
 * 保留已知模式并去重；缺省/空数组表示所有模式，显式未知模式必须报错而不能扩大范围。
 */
export function normalizeRuleModes(raw: unknown): AgentMode[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) && typeof raw !== "string") throw new Error("规则 modes 必须是模式数组或模式名称");
  const items = Array.isArray(raw) ? raw : raw.split(",");
  const out: AgentMode[] = [];
  for (const item of items) {
    if (typeof item !== "string") throw new Error("规则模式必须是字符串");
    const mode = item.trim().toLowerCase();
    if (!mode) continue;
    if (!(AGENT_MODES as readonly string[]).includes(mode)) throw new Error(`未知规则模式：${item}`);
    if (out.includes(mode as AgentMode)) continue;
    out.push(mode as AgentMode);
  }
  return out.length > 0 ? out : undefined;
}

/** 规则是否适用于该模式：没有 modes 的旧规则适用所有模式；没给模式时不做过滤。 */
export function ruleAppliesToMode(rule: Pick<RuleFile, "modes">, mode: AgentMode | undefined): boolean {
  if (!mode || !rule.modes || rule.modes.length === 0) return true;
  return rule.modes.includes(mode);
}

export function listRuleIds(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function createRuleCache(
  onError: (rule: RuleFile) => void = () => {},
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
) {
  const cache = new Map<string, { mtimeMs: number; rule: RuleFile }>();
  // 读文件失败（如编辑器保存时的瞬时 EBUSY）不缓存，下一轮重试；这里记已报过的 path，避免每轮刷日志。
  const readFailureReported = new Set<string>();
  return {
    load(dirs: ReadonlyArray<{ dir: string; scope: RuleScope }>): RuleFile[] {
      const out: RuleFile[] = [];
      for (const { dir, scope } of dirs) {
        for (const id of listRuleIds(dir)) {
          const path = join(dir, `${id}.md`);
          let mtimeMs: number;
          try {
            mtimeMs = statSync(path).mtimeMs;
          } catch {
            continue;
          }
          const hit = cache.get(path);
          if (hit && hit.mtimeMs === mtimeMs) {
            out.push(hit.rule);
            continue;
          }
          let content: string;
          try {
            content = readFile(path);
          } catch (error) {
            const rule: RuleFile = { id, scope, path, title: id, enabled: false, body: "", error: errorText(error) };
            if (!readFailureReported.has(path)) {
              readFailureReported.add(path);
              onError(rule);
            }
            out.push(rule);
            continue;
          }
          readFailureReported.delete(path);
          const rule = parseRule(id, scope, path, content);
          if (rule.error) onError(rule);
          cache.set(path, { mtimeMs, rule });
          out.push(rule);
        }
      }
      return out;
    },
  };
}

/** 启用的规则 → contextFiles 条目；给了 mode 时只取适用该模式的（旧规则无 modes，照常参与）。 */
export function activeRuleContextFiles(
  rules: readonly RuleFile[],
  mode?: AgentMode,
): Array<{ path: string; content: string }> {
  return rules
    .filter((rule) => rule.enabled && !rule.error && rule.body.trim() && ruleAppliesToMode(rule, mode))
    .map((rule) => ({ path: rule.path, content: rule.body }));
}
