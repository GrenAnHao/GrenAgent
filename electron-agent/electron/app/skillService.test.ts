import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillService } from './skillService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'electron-agent-skills-'));
  directories.push(home);
  return { home, service: new SkillService(home) };
}

describe('SkillService', () => {
  it('creates a skill and lists the .agents directory ahead of the Pi fallback directory', async () => {
    const { home, service } = await fixture();
    await mkdir(join(home, '.pi', 'agent', 'skills', 'same'), { recursive: true });
    await writeFile(join(home, '.pi', 'agent', 'skills', 'same', 'SKILL.md'), '---\nname: same\ndescription: fallback\n---\n');
    await service.create('same', 'first description', 'Use it.');

    await expect(service.list()).resolves.toEqual([{ name: 'same', description: 'first description', path: join(home, '.agents', 'skills', 'same'), scope: 'global' }]);
    await expect(readFile(join(home, '.agents', 'skills', 'same', 'SKILL.md'), 'utf8')).resolves.toContain('description: "first description"');
  });

  it('reads folded and literal YAML descriptions instead of the block marker', async () => {
    const { home, service } = await fixture();
    for (const [name, header] of [
      ['folded', 'description: >-\n  第一行\n  第二行'],
      ['literal', 'description: |\n  line one\n  line two'],
      ['quoted', "description: 'has: colon'"],
      ['broken', 'description: plain text\n  : not yaml ['],
    ]) {
      await mkdir(join(home, '.agents', 'skills', name), { recursive: true });
      await writeFile(join(home, '.agents', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n${header}\n---\n`);
    }
    const byName = Object.fromEntries((await service.list()).map((skill) => [skill.name, skill.description]));
    expect(byName.folded).toBe('第一行 第二行');
    expect(byName.literal).toBe('line one line two');
    expect(byName.quoted).toBe('has: colon');
    expect(byName.broken).toBe('plain text');
  });

  it('inspects and edits a project skill, then archives the entire directory outside discovery', async () => {
    const { home, service } = await fixture();
    const project = join(home, 'project'), path = join(project, '.agents', 'skills', 'review');
    const original = '---\r\nname: review\r\ndisable-model-invocation: true\r\n---\r\n# body\r\n';
    await mkdir(join(path, 'scripts'), { recursive:true });
    await writeFile(join(path, 'SKILL.md'), original);
    await writeFile(join(path, 'scripts', 'check.js'), 'test');
    expect(await service.list()).toEqual([]);
    expect(await service.list(project)).toMatchObject([{ name:'review', scope:'project', disableModelInvocation:true }]);
    const detail = await service.detail(path, project);
    expect(detail.content).toBe(original);
    expect(detail.files).toEqual(['scripts/', 'SKILL.md']);
    expect(await service.files(path, 'scripts', project)).toEqual(['check.js']);
    await expect(service.files(path, '../other', project)).rejects.toThrow();
    await service.save(path, original, original + 'new\r\n', project);
    await expect(service.save(path, original, 'stale', project)).rejects.toThrow('其他地方更改');
    await expect(service.archive(path)).rejects.toThrow();
    const archived = await service.archive(path, project);
    expect(await readFile(join(archived, 'scripts', 'check.js'), 'utf8')).toBe('test');
    expect(await readFile(join(archived, 'SKILL.md'), 'utf8')).toBe(original + 'new\r\n');
    expect(await service.list(project)).toEqual([]);
    await expect(service.remove(archived, project)).rejects.toThrow();
  });

  it('does not treat a nested resource containing SKILL.md as a deletable catalog item', async () => {
    const { service } = await fixture();
    const skill = await service.create('nested', '', '');
    const resource = join(skill.path, 'example');
    await mkdir(resource); await writeFile(join(resource, 'SKILL.md'), 'keep');
    await expect(service.remove(resource)).rejects.toThrow();
    expect(await readFile(join(resource, 'SKILL.md'), 'utf8')).toBe('keep');
  });

  it('imports valid skill directories and Markdown files', async () => {
    const { home, service } = await fixture();
    const source = await mkdtemp(join(tmpdir(), 'electron-agent-skill-source-'));
    directories.push(source);
    await mkdir(join(source, 'directory-skill'));
    await writeFile(join(source, 'directory-skill', 'SKILL.md'), '---\nname: imported\ndescription: imported skill\n---\n');
    await writeFile(join(source, 'file-skill.md'), '# body');

    await expect(service.importDirectory(join(source, 'directory-skill'))).resolves.toMatchObject({ name: 'imported', description: 'imported skill' });
    await expect(service.importFile(join(source, 'file-skill.md'))).resolves.toMatchObject({ name: 'file-skill', description: '' });
    await expect(service.list()).resolves.toHaveLength(2);
    expect(home).toContain('electron-agent-skills-');
  });

  it('refuses invalid names and deletion outside global skill directories', async () => {
    const { home, service } = await fixture();
    await expect(service.create('../escape', '', '')).rejects.toThrow('技能名称不能以点开头');
    await expect(service.remove(home)).rejects.toThrow('拒绝删除');
    await service.create('removable', '', '');
    await expect(service.remove(join(home, '.agents', 'skills', 'removable'))).resolves.toBeUndefined();
  });
});
