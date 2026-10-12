// 检查 .agents/notes/implemented/ 下每篇笔记都有验证段和证据。
// 规则：
//   1. 必须有标题为 "## Verification" 或 "## 验证" 的段落；
//   2. 段内必须出现至少一条证据，任一即可：
//      a. .agents/evidence/ 下的路径（路径必须真实存在）；
//      b. verify-* skill 名 + 结果词；
//      c. 具体的测试/检查命令（vitest、jest、playwright、tsc、ui:check、cargo test、
//         pnpm/npm/yarn/bun run …、npx …、node scripts/…）或测试文件（*.test.* / *.spec.*）+ 结果词；
//      结果词：通过 / 失败 / 部分通过 / pass / fail / partial / 绿 / green / ✅ / ❌；
//   3. 确实没法实跑的（纯文档、流程、旧笔记），在段内写 `verify: n/a <原因>` 豁免，原因不能为空；
//   4. 记了测试命令或测试文件、但没写结果的，只给警告不报错（旧笔记常见），提醒补上结果。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const dir = join(root, ".agents", "notes", "implemented");

const RESULT = /(通过|失败|部分通过|\bpass(ed)?\b|\bfail(ed)?\b|\bpartial\b|绿|\bgreen\b|✅|❌)/i;
const TEST_CMD =
  /(\bvitest\b|\bjest\b|\bplaywright\b|\btsc\b|ui:check|cdp:check|cargo\s+test|\b(pnpm|npm|yarn|bun)\s+(run\s+)?[\w:-]+|\bnpx\s+\S+|\bnode\s+scripts\/\S+)/i;
const TEST_FILE = /[\w./-]+\.(test|spec)\.[cm]?[jt]sx?\b/i;

function walk(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

const errors: string[] = [];
const warnings: string[] = [];
for (const file of walk(dir)) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const text = readFileSync(file, "utf8");
  const m = text.match(/^##\s*(Verification|验证)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) { errors.push(`${rel}: 缺少 "## Verification" / "## 验证" 段`); continue; }
  const body = m[2];
  const na = body.match(/verify:\s*n\/a\s*(.*)/i);
  if (na) {
    if (!na[1].trim()) errors.push(`${rel}: verify: n/a 必须写原因`);
    continue;
  }
  const paths = [...body.matchAll(/\.agents\/evidence\/[^\s)`'"]+/g)].map((x) => x[0]);
  const missing = paths.filter((p) => !existsSync(join(root, p)));
  missing.forEach((p) => errors.push(`${rel}: 证据路径不存在 ${p}`));
  const hasResult = RESULT.test(body);
  const hasSkillRun = /verify-[\w-]+/.test(body) && hasResult;
  const hasTest = TEST_CMD.test(body) || TEST_FILE.test(body);
  if (paths.length > 0 || hasSkillRun || (hasTest && hasResult)) continue;
  if (hasTest) {
    warnings.push(`${rel}: 记了测试命令/文件但没写结果（通过 / 失败 / 部分通过）`);
    continue;
  }
  errors.push(`${rel}: 验证段没有证据（需 .agents/evidence/ 路径、verify-* + 结果，或测试命令 + 结果）`);
}

if (warnings.length) console.warn("verify-note-evidence 警告：\n" + warnings.map((w) => "  - " + w).join("\n"));
if (errors.length) {
  console.error("verify-note-evidence 失败：\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("verify-note-evidence 通过");
