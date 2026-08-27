import { cp, mkdir, mkdtemp, readFile, readdir, rm, rename, stat, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddSkillInput } from "./validation.js";
import { normalizeSkillMarkdown, validateResourceName } from "./validation.js";
export interface InstallSkillResult { name: string; path: string; files: number; }
export interface PreparedSkill { name: string; target: string; staged: string; files: number; }
async function countSafe(root: string): Promise<number> { let n = 0; for (const e of await readdir(root, { withFileTypes: true })) { const p = join(root, e.name); const m = await lstat(p); if (m.isSymbolicLink()) throw new Error("Skill 目录不允许符号链接"); if (e.isDirectory()) n += await countSafe(p); else n++; } return n; }
export async function prepareSkill(input: AddSkillInput, home = homedir()): Promise<PreparedSkill> {
  const err = validateResourceName(input.name); if (err) throw new Error(err);
  const root = join(home, ".agents", "skills"); const target = join(root, input.name); await mkdir(root, { recursive: true }); const staged = await mkdtemp(join(root, "." + input.name + "-"));
  try {
    if (input.source.type === "content") await writeFile(join(staged, "SKILL.md"), normalizeSkillMarkdown(input.name, input.description, input.source.content));
    else if (input.source.type === "file") await writeFile(join(staged, "SKILL.md"), normalizeSkillMarkdown(input.name, input.description, await readFile(input.source.path, "utf8")));
    else { const source = input.source.path; if (!(await stat(join(source, "SKILL.md"))).isFile()) throw new Error("Skill 目录缺少 SKILL.md"); await countSafe(source); await cp(source, staged, { recursive: true, force: true }); const md = await readFile(join(staged, "SKILL.md"), "utf8"); await writeFile(join(staged, "SKILL.md"), normalizeSkillMarkdown(input.name, input.description, md)); }
    return { name: input.name, target, staged, files: await countSafe(staged) };
  } catch (e) { await rm(staged, { recursive: true, force: true }); throw e; }
}
export async function commitPreparedSkill(prepared: PreparedSkill, replace: boolean): Promise<InstallSkillResult> {
  const exists = await stat(prepared.target).then(() => true).catch(() => false); if (exists && !replace) throw new Error("Skill \"" + prepared.name + "\" 已存在，请显式设置 replace=true");
  await mkdir(dirname(prepared.target), { recursive: true }); const backup = prepared.target + ".backup-" + randomUUID();
  try { if (exists) await rename(prepared.target, backup); await rename(prepared.staged, prepared.target); if (exists) await rm(backup, { recursive: true, force: true }); return { name: prepared.name, path: prepared.target, files: prepared.files }; }
  catch (e) { if (exists) await rename(backup, prepared.target).catch(() => {}); throw new Error("Skill 切换失败: " + (e instanceof Error ? e.message : String(e))); }
}
export async function discardPreparedSkill(prepared: PreparedSkill): Promise<void> { await rm(prepared.staged, { recursive: true, force: true }); }
export async function installSkill(input: AddSkillInput, home = homedir()): Promise<InstallSkillResult> { const p = await prepareSkill(input, home); try { return await commitPreparedSkill(p, input.replace === true); } catch (e) { await discardPreparedSkill(p); throw e; } }
