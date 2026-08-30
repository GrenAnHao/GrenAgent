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
