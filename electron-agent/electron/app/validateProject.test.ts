import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateProject } from './validateProject';

it('accepts real project directories and rejects temporary projects, files and links to works', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-project-validation-'));
  try {
    const works = join(root, 'works'); const project = join(root, 'project'); const temporary = join(works, 'session');
    mkdirSync(temporary, { recursive: true }); mkdirSync(project);
    writeFileSync(join(root, 'file.md'), '# file');
    symlinkSync(temporary, join(root, 'temporary-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(validateProject(project, works)).resolves.toBe(project.replace(/\\/g, '/'));
    await expect(validateProject(works, works)).rejects.toThrow('TEMPORARY_PROJECT_NOT_ALLOWED');
    await expect(validateProject(temporary, works)).rejects.toThrow('TEMPORARY_PROJECT_NOT_ALLOWED');
    await expect(validateProject(join(root, 'temporary-link'), works)).rejects.toThrow('TEMPORARY_PROJECT_NOT_ALLOWED');
    await expect(validateProject(join(root, 'file.md'), works)).rejects.toThrow('PROJECT_NOT_DIRECTORY');
    await expect(validateProject(join(root, 'missing'), works)).rejects.toThrow();
    await expect(validateProject('', works)).rejects.toThrow('PROJECT_REQUIRED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
