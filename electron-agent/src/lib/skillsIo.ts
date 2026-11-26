import { invoke } from '../platform/runtime';

export interface SkillInfo {
  /** 技能名（不含 `skill:` 前缀）。 */
  name: string;
  description: string;
  /** 技能目录绝对路径，删除时回传。 */
  path: string;
  scope: string;
  disableModelInvocation?: boolean;
}
export function listSkills(workspace?: string): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>('list_skills', { workspace });
}

export function createSkill(name: string, description: string, body: string): Promise<SkillInfo> {
  return invoke<SkillInfo>('create_skill', { name, description, body });
}

export function deleteSkill(path: string, workspace?: string): Promise<void> {
  return invoke<void>('delete_skill', { path, workspace });
}

/** 把一个技能目录（含 SKILL.md）整体导入到全局技能目录。 */
export function importSkillFromDir(src: string): Promise<SkillInfo> {
  return invoke<SkillInfo>('import_skill_from_dir', { src });
}

/** 把单个 Markdown 文件作为 SKILL.md 导入（新建技能目录）。 */
export function importSkillFromFile(src: string): Promise<SkillInfo> {
  return invoke<SkillInfo>('import_skill_from_file', { src });
}

/** 从 zip 安装技能（解压并定位 SKILL.md）。 */
export function installSkillFromZip(src: string): Promise<SkillInfo> {
  return invoke<SkillInfo>('install_skill_from_zip', { src });
}

/** 在系统文件管理器中打开全局技能目录，返回其路径。 */
export function openSkillsDir(): Promise<string> {
  return invoke<string>('open_skills_dir');
}

export interface SkillDetail { content: string; files: string[] }
export const readSkill = (path: string, workspace: string) => invoke<SkillDetail>('read_skill', { path, workspace });
export const saveSkill = (path: string, workspace: string, original: string, content: string) =>
  invoke<void>('save_skill', { path, workspace, original, content });
export const archiveSkill = (path: string, workspace: string) => invoke<string>('archive_skill', { path, workspace });
export const openSkillFolder = (path: string, workspace: string) => invoke<void>('open_skill_folder', { path, workspace });

export const listSkillFiles = (path: string, workspace: string, folder: string) =>
  invoke<string[]>('list_skill_files', { path, workspace, folder });
