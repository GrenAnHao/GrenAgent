import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PromptLibraryService, ruleIdFromTitle } from './promptLibraryService';

let agentDir = '';
let workspace = '';
let service: PromptLibraryService;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'library-agent-'));
  workspace = await mkdtemp(join(tmpdir(), 'library-ws-'));
  service = new PromptLibraryService(agentDir);
});

describe('命令', () => {
  it('保存时写 description 和自动生成的 argument-hint，列表能读回参数', async () => {
    await service.saveCommand({ name: 'refactor', description: '重构', body: '改 {file} 为 {style=fp}\n', reserved: [] });
    expect(await readFile(join(agentDir, 'prompts', 'refactor.md'), 'utf8')).toBe(
      '---\ndescription: "重构"\nargument-hint: "<file> [style]"\n---\n改 {file} 为 {style=fp}\n',
    );
    const [command] = await service.listCommands();
    expect(command).toMatchObject({ name: 'refactor', description: '重构', params: [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }] });
  });

  it('没有参数时不写 argument-hint', async () => {
    await service.saveCommand({ name: 'review', description: '', body: '看看', reserved: [] });
    expect(await readFile(join(agentDir, 'prompts', 'review.md'), 'utf8')).toBe('---\ndescription: ""\n---\n看看\n');
  });

  it('拒绝非法名、保留名、重名和空正文', async () => {
    await expect(service.saveCommand({ name: '../x', description: '', body: 'a', reserved: [] })).rejects.toThrow('命令名只能用');
    await expect(service.saveCommand({ name: 'compact', description: '', body: 'a', reserved: ['compact'] })).rejects.toThrow('重名');
    await expect(service.saveCommand({ name: 'a', description: '', body: ' ', reserved: [] })).rejects.toThrow('提示词不能为空');
    await service.saveCommand({ name: 'a', description: '', body: 'x', reserved: [] });
    await expect(service.saveCommand({ name: 'a', description: '', body: 'y', reserved: [] })).rejects.toThrow('已存在');
  });

  it('改名时写新文件并删掉旧文件；同名覆盖允许', async () => {
    await service.saveCommand({ name: 'a', description: '', body: 'x', reserved: [] });
    await service.saveCommand({ originalName: 'a', name: 'a', description: '新', body: 'x2', reserved: [] });
    await service.saveCommand({ originalName: 'a', name: 'b', description: '', body: 'x3', reserved: [] });
    expect(existsSync(join(agentDir, 'prompts', 'a.md'))).toBe(false);
    expect((await service.listCommands()).map((command) => command.name)).toEqual(['b']);
  });

  it('删除拒绝带路径的名字', async () => {
    await expect(service.deleteCommand('../x')).rejects.toThrow('命令名无效');
  });

  it('列表里坏掉的模板带 error', async () => {
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await writeFile(join(agentDir, 'prompts', 'bad.md'), '---\ndescription: [\n---\nx');
    const [command] = await service.listCommands();
    expect(command.error).toBeTruthy();
  });
});

describe('规则', () => {
  it('新建全局和项目规则，列表全局在前', async () => {
    await service.saveRule({ workspace, scope: 'project', title: '用 pnpm', enabled: true, body: '- pnpm' });
    await service.saveRule({ workspace, scope: 'global', title: '中文回答', enabled: false, body: '- 中文' });
    expect(await readFile(join(agentDir, 'rules', '中文回答.md'), 'utf8')).toBe('---\ntitle: "中文回答"\nenabled: false\n---\n- 中文\n');
    const rules = await service.listRules(workspace);
    expect(rules.map((rule) => [rule.scope, rule.id, rule.enabled])).toEqual([
      ['global', '中文回答', false],
      ['project', '用-pnpm', true],
    ]);
  });

  it('没有工作区时只列全局，保存项目规则报错', async () => {
    expect(await service.listRules('')).toEqual([]);
    await expect(service.saveRule({ workspace: '', scope: 'project', title: 'x', enabled: true, body: 'x' })).rejects.toThrow('项目规则需要先打开工作区');
  });

  it('改标题保留文件名；换范围时搬文件', async () => {
    const created = await service.saveRule({ workspace, scope: 'global', title: 'A', enabled: true, body: 'a' });
    const renamed = await service.saveRule({ workspace, scope: 'global', original: { scope: 'global', id: created.id }, title: 'B', enabled: true, body: 'b' });
    expect(renamed.id).toBe('A');
    const moved = await service.saveRule({ workspace, scope: 'project', original: { scope: 'global', id: 'A' }, title: 'B', enabled: true, body: 'b' });
    expect(moved.scope).toBe('project');
    expect(existsSync(join(agentDir, 'rules', 'A.md'))).toBe(false);
    expect(existsSync(join(workspace, '.pi', 'rules', 'B.md'))).toBe(true);
  });

  it('开关只改 enabled，保留标题和正文', async () => {
    const rule = await service.saveRule({ workspace, scope: 'global', title: 'T', enabled: true, body: 'body' });
    await service.setRuleEnabled({ scope: 'global', id: rule.id }, false, workspace);
    expect(await readFile(rule.path, 'utf8')).toBe('---\ntitle: "T"\nenabled: false\n---\nbody\n');
  });

  it('删除和开关拒绝带路径的 id', async () => {
    await expect(service.deleteRule({ scope: 'global', id: '../x' }, workspace)).rejects.toThrow('规则标识无效');
    await expect(service.setRuleEnabled({ scope: 'global', id: 'a/b' }, true, workspace)).rejects.toThrow('规则标识无效');
  });
});

describe('ruleIdFromTitle', () => {
  it('清掉不合法字符并避开已有 id', () => {
    expect(ruleIdFromTitle('提交 前/跑测试!', new Set())).toBe('提交-前-跑测试');
    expect(ruleIdFromTitle('a', new Set(['a', 'a-2']))).toBe('a-3');
    expect(ruleIdFromTitle('!!!', new Set())).toBe('rule');
  });
});
