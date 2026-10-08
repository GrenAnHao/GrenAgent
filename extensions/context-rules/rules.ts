// 规则文件：全局 <agentDir>/rules/*.md，项目 <cwd>/.pi/rules/*.md。一条一个文件，frontmatter 有 title 和 enabled。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type RuleScope = "global" | "project";

export interface RuleFile {
  id: string;
  scope: RuleScope;
  path: string;
  title: string;
  enabled: boolean;
  body: string;
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
    const { frontmatter, body } = parseFrontmatter<{ title?: unknown; enabled?: unknown }>(content);
    const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : id;
    return { id, scope, path, title, enabled: frontmatter.enabled !== false, body };
  } catch (error) {
    return { id, scope, path, title: id, enabled: false, body: "", error: errorText(error) };
  }
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

export function createRuleCache(onError: (rule: RuleFile) => void = () => {}) {
  const cache = new Map<string, { mtimeMs: number; rule: RuleFile }>();
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
          let rule: RuleFile;
          try {
            rule = parseRule(id, scope, path, readFileSync(path, "utf8"));
          } catch (error) {
            rule = { id, scope, path, title: id, enabled: false, body: "", error: errorText(error) };
          }
          if (rule.error) onError(rule);
          cache.set(path, { mtimeMs, rule });
          out.push(rule);
        }
      }
      return out;
    },
  };
}

export function activeRuleContextFiles(rules: readonly RuleFile[]): Array<{ path: string; content: string }> {
  return rules
    .filter((rule) => rule.enabled && !rule.error && rule.body.trim())
    .map((rule) => ({ path: rule.path, content: rule.body }));
}
