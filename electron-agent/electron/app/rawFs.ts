import { createRequire } from 'node:module';
import * as nodeFs from 'node:fs';

/**
 * 不带 Electron asar 补丁的 fs，给遍历用户工作区的代码用。
 *
 * Electron 进程里的 `node:fs` 把 `*.asar` 当目录：对它做一次 stat / lstat / existsSync 就会打开归档并缓存句柄，
 * 进程不退就一直占着。仓库里有打包产物（release/win-unpacked/resources/app.asar）时，开着的 GrenAgent
 * 只要列过一次文件树，下一次 electron-builder 清理输出目录就报 EBUSY。工作区里的 .asar 对用户来说只是文件。
 * 普通 Node（vitest、脚本）里没有 original-fs，退回 node:fs，两者行为相同。
 */
type FsModule = typeof nodeFs;

function load(): FsModule {
  if (!process.versions.electron) return nodeFs;
  return createRequire(import.meta.url)('original-fs') as FsModule;
}

export const rawFs: FsModule = load();
export const rawFsPromises: FsModule['promises'] = rawFs.promises;
