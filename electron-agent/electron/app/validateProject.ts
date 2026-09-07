import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

/** Validate a new manual binding without creating or promoting a temporary workspace. */
export async function validateProject(workspace: string, worksDir: string): Promise<string> {
  if (!workspace.trim()) throw new Error('PROJECT_REQUIRED');
  const target = await realpath(workspace);
  if (!(await stat(target)).isDirectory()) throw new Error('PROJECT_NOT_DIRECTORY');
  const temporary = await realpath(worksDir);
  const rel = relative(temporary, target);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('TEMPORARY_PROJECT_NOT_ALLOWED');
  return target.replace(/\\/g, '/');
}
