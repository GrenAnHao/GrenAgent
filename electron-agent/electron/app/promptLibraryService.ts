import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argumentHint, COMMAND_NAME_RE, parsePromptParams, type PromptParam } from '../../../extensions/prompt-commands/syntax.js';
import { isSafeFileStem, parseTemplate, promptsDir } from '../../../extensions/prompt-commands/templates.js';
import {
  globalRulesDir,
  listRuleIds,
  parseRule,
  projectRulesDir,
  type RuleFile,
  type RuleScope,
} from '../../../extensions/context-rules/rules.js';

export interface PromptCommandInfo {
  name: string;
  description: string;
  body: string;
  params: PromptParam[];
  path: string;
  error?: string;
}

export interface SaveCommandInput {
  originalName?: string;
  name: string;
  description: string;
  body: string;
  /** 内置、扩展、技能命令名：渲染层从 agent_get_commands 取，不能和它们重名。 */
  reserved: readonly string[];
}

export interface RuleRef {
  scope: RuleScope;
  id: string;
}

export interface SaveRuleInput {
  workspace?: string;
  scope: RuleScope;
  original?: RuleRef;
  title: string;
  enabled: boolean;
  body: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 先写同目录临时文件再改名，崩溃或写到一半失败时不会留下半截文件。 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

function commandMarkdown(description: string, body: string): string {
  const params = parsePromptParams(body);
  const lines = ['---', `description: ${JSON.stringify(description.trim())}`];
  if (params.length > 0) lines.push(`argument-hint: ${JSON.stringify(argumentHint(params))}`);
  lines.push('---', body, '');
  return lines.join('\n');
}

function ruleMarkdown(title: string, enabled: boolean, body: string): string {
  return ['---', `title: ${JSON.stringify(title)}`, `enabled: ${enabled}`, '---', body, ''].join('\n');
}

export function ruleIdFromTitle(title: string, taken: ReadonlySet<string>): string {
  const base = title.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rule';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export class PromptLibraryService {
  constructor(private readonly agentDir: string) {}

  async listCommands(): Promise<PromptCommandInfo[]> {
    const dir = promptsDir(this.agentDir);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3));
    } catch {
      return [];
    }
    const commands = await Promise.all(
      names.map(async (name): Promise<PromptCommandInfo> => {
        const path = join(dir, `${name}.md`);
        try {
          return { ...parseTemplate(name, await readFile(path, 'utf8')), path };
        } catch (error) {
          return { name, description: '', body: '', params: [], path, error: errorText(error) };
        }
      }),
    );
    return commands.sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveCommand(input: SaveCommandInput): Promise<PromptCommandInfo> {
    const name = input.name.trim();
    const body = normalizeBody(input.body);
    if (!COMMAND_NAME_RE.test(name)) throw new Error('命令名只能用字母、数字、中文、- 和 _，最长 64 个字符');
    if (input.reserved.includes(name)) throw new Error(`/${name} 和已有的内置、扩展或技能命令重名`);
    if (!body) throw new Error('提示词不能为空');
    if (input.originalName !== undefined && !isSafeFileStem(input.originalName)) throw new Error('命令名无效');
    const dir = promptsDir(this.agentDir);
    const path = join(dir, `${name}.md`);
    const isNewName = input.originalName !== name;
    if (isNewName && (await exists(path))) throw new Error(`命令 /${name} 已存在`);
    await mkdir(dir, { recursive: true });
    await writeAtomic(path, commandMarkdown(input.description, body));
    if (input.originalName !== undefined && isNewName) await rm(join(dir, `${input.originalName}.md`), { force: true });
    return { name, description: input.description.trim(), body, params: parsePromptParams(body), path };
  }

  async deleteCommand(name: string): Promise<void> {
    if (!isSafeFileStem(name)) throw new Error('命令名无效');
    await rm(join(promptsDir(this.agentDir), `${name}.md`), { force: true });
  }

  async listRules(workspace?: string): Promise<RuleFile[]> {
    const scopes: Array<{ scope: RuleScope; dir: string }> = [{ scope: 'global', dir: globalRulesDir(this.agentDir) }];
    if (workspace) scopes.push({ scope: 'project', dir: projectRulesDir(workspace) });
    const rules: RuleFile[] = [];
    for (const { scope, dir } of scopes) {
      for (const id of listRuleIds(dir)) {
        const path = join(dir, `${id}.md`);
        try {
          rules.push(parseRule(id, scope, path, await readFile(path, 'utf8')));
        } catch (error) {
          rules.push({ id, scope, path, title: id, enabled: false, body: '', error: errorText(error) });
        }
      }
    }
    return rules;
  }

  async saveRule(input: SaveRuleInput): Promise<RuleFile> {
    const title = input.title.trim();
    const body = normalizeBody(input.body);
    if (!title) throw new Error('规则名称不能为空');
    if (!body) throw new Error('规则内容不能为空');
    const dir = this.rulesDir(input.scope, input.workspace);
    // 写新文件之前先把旧文件路径算好：校验失败时不能留下已写的新文件。
    const originalPath = input.original ? this.rulePath(input.original, input.workspace) : undefined;
    const keepId = input.original !== undefined && input.original.scope === input.scope;
    const id = keepId ? input.original!.id : ruleIdFromTitle(title, new Set(listRuleIds(dir)));
    const path = join(dir, `${id}.md`);
    await mkdir(dir, { recursive: true });
    await writeAtomic(path, ruleMarkdown(title, input.enabled, body));
    if (originalPath && !keepId) await rm(originalPath, { force: true });
    return { id, scope: input.scope, path, title, enabled: input.enabled, body };
  }

  async setRuleEnabled(ref: RuleRef, enabled: boolean, workspace?: string): Promise<void> {
    const path = this.rulePath(ref, workspace);
    const rule = parseRule(ref.id, ref.scope, path, await readFile(path, 'utf8'));
    if (rule.error) throw new Error(`规则文件解析失败：${rule.error}`);
    await writeAtomic(path, ruleMarkdown(rule.title, enabled, normalizeBody(rule.body)));
  }

  async deleteRule(ref: RuleRef, workspace?: string): Promise<void> {
    await rm(this.rulePath(ref, workspace), { force: true });
  }

  private rulePath(ref: RuleRef, workspace?: string): string {
    if (!isSafeFileStem(ref.id)) throw new Error('规则标识无效');
    return join(this.rulesDir(ref.scope, workspace), `${ref.id}.md`);
  }

  private rulesDir(scope: RuleScope, workspace?: string): string {
    if (scope === 'global') return globalRulesDir(this.agentDir);
    if (!workspace) throw new Error('项目规则需要先打开工作区');
    return projectRulesDir(workspace);
  }
}
