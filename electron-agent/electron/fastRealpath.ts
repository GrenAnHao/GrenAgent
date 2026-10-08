import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

type RealpathSync = typeof fs.realpathSync;

let original: RealpathSync | undefined;

function fromModuleLoader(options: unknown): boolean {
  return typeof options === 'object' && options !== null && Object.getOwnPropertySymbols(options).length > 0;
}

/**
 * 把 fs.realpathSync 换成系统调用版（realpathSync.native），失败时退回原实现。
 *
 * Node 的 JS 版在 Windows 上逐级 lstat 每一段路径，Electron 里一次约 1.2ms，native 约 0.25ms。
 * pi 每建一个工作区运行时都会对每个技能路径 canonicalize 三次（约 110 个技能），
 * 启动和切到冷项目时这一项在主进程上累计 4 秒。pi 用 ESM 具名导入 realpathSync，
 * 改完 fs 上的属性要 syncBuiltinESMExports 才同步到这些导入。
 *
 * CJS 的 require 也经 fs.realpathSync 解析模块路径，传的选项带 Symbol 键的内部缓存。
 * 这类调用仍交给原实现：native 返回磁盘上的大小写，原实现保留传入的大小写，
 * 换掉后同一个包经 import 和 require 会按两个路径各加载一份。
 */
export function installFastRealpath(): void {
  if (original) return;
  const previous = fs.realpathSync;
  const fast = ((path: fs.PathLike, options?: fs.EncodingOption) => {
    if (fromModuleLoader(options)) return previous(path, options);
    try {
      return fast.native(path, options);
    } catch {
      return previous(path, options);
    }
  }) as RealpathSync;
  fast.native = previous.native;
  original = previous;
  fs.realpathSync = fast;
  syncBuiltinESMExports();
}

/** 仅测试。 */
export function uninstallFastRealpathForTest(): void {
  if (!original) return;
  fs.realpathSync = original;
  original = undefined;
  syncBuiltinESMExports();
}
