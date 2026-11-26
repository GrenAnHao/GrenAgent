import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';

/** Save the file that was previewed, never follow a replaced link or recreate a removed file. */
export async function replacePreviewedFile(path: string, original: string, content: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('只能修改普通文件');
  if (await readFile(path, 'utf8') !== original) throw new Error('文件已在其他地方更改，请重新打开后再保存');
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: info.mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
