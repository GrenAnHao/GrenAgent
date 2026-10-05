import { readFileSync } from 'node:fs';
import { splitSkillCommand } from '../../src/features/chat/skillCommandText.js';

export interface SkillFile {
  name: string;
  filePath: string;
  baseDir: string;
}

/** Pi 只按第一个空格切技能名。含空白或引号的名字要在交给 session.prompt 之前展开。 */
function needsOwnExpansion(name: string): boolean {
  return /[\s"]/.test(name);
}

function matchesSkill(body: string, name: string): boolean {
  if (!name) return false;
  if (body === name) return true;
  return body.startsWith(name) && /^\s/.test(body.slice(name.length));
}

function longestSpacedSkill(body: string, skills: readonly SkillFile[]): SkillFile | null {
  let best: SkillFile | null = null;
  for (const skill of skills) {
    if (!needsOwnExpansion(skill.name) || !matchesSkill(body, skill.name)) continue;
    if (!best || skill.name.length > best.name.length) best = skill;
  }
  return best;
}

/** 与 pi `_expandSkillCommand` 同一段 `<skill>` 包装，避免两套正文。 */
function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return normalized;
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4).trim();
}

function renderSkill(skill: SkillFile, body: string, args: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

function expandSkill(skill: SkillFile, args: string, readFile: (path: string) => string, original: string): string {
  try {
    const body = stripFrontmatter(readFile(skill.filePath)).trim();
    return renderSkill(skill, body, args);
  } catch {
    return original;
  }
}

export function skillsFromSession(session: {
  resourceLoader?: { getSkills(): { skills?: ReadonlyArray<SkillFile> } };
}): SkillFile[] {
  const skills = session.resourceLoader?.getSkills().skills;
  if (!skills) return [];
  return skills.map((skill) => ({ name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir }));
}

/**
 * 把带空格（或引号）的 `/skill:` 调用展开成 pi 自己会写的 `<skill>` 块。
 * 不含空白的名字原样交回，仍由 pi 展开。读文件失败时保留原文。
 */
export function expandSpacedSkillCommand(
  text: string,
  skills: readonly SkillFile[],
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  const split = splitSkillCommand(text);
  if (!split) return text;

  if (split.kind === 'quoted') {
    if (!needsOwnExpansion(split.name)) {
      return split.args ? `/skill:${split.name} ${split.args}` : `/skill:${split.name}`;
    }
    const skill = skills.find((item) => item.name === split.name);
    if (!skill) return text;
    return expandSkill(skill, split.args, readFile, text);
  }

  const skill = longestSpacedSkill(split.body, skills);
  if (!skill) return text;
  return expandSkill(skill, split.body.slice(skill.name.length).trim(), readFile, text);
}
