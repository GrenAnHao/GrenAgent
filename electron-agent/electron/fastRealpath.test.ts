import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFastRealpath, uninstallFastRealpathForTest } from './fastRealpath';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fast-realpath-'));
});

afterEach(() => {
  uninstallFastRealpathForTest();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('installFastRealpath', () => {
  it('ESM 具名导入的 realpathSync 改走系统调用，结果与原实现一致', () => {
    const file = join(root, 'SKILL.md');
    writeFileSync(file, '');
    const expected = realpathSync(file);
    const native = vi.spyOn(fs.realpathSync, 'native');

    installFastRealpath();

    expect(realpathSync(file)).toBe(expected);
    expect(native).toHaveBeenCalledWith(file, undefined);
  });

  it('系统调用失败时退回原实现，原实现的错误照常抛出', () => {
    const dir = join(root, 'skills');
    mkdirSync(dir);
    const expected = fs.realpathSync(dir);
    installFastRealpath();
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    });

    expect(realpathSync(dir)).toBe(expected);
    expect(() => realpathSync(join(root, 'missing'))).toThrow(/ENOENT/);
  });

  it('CJS 模块加载器带内部缓存键的调用仍走原实现，require 的路径大小写不变', () => {
    const file = join(root, 'index.js');
    writeFileSync(file, '');
    const native = vi.spyOn(fs.realpathSync, 'native');
    installFastRealpath();

    realpathSync(file, { [Symbol('realpathCacheKey')]: new Map() } as never);

    expect(native).not.toHaveBeenCalled();
  });

  it('保留 realpathSync.native，重复安装不叠加', () => {
    installFastRealpath();
    const first = fs.realpathSync;
    installFastRealpath();
    expect(fs.realpathSync).toBe(first);
    expect(typeof fs.realpathSync.native).toBe('function');
  });

  it('跟随符号链接', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    try {
      symlinkSync(target, link, 'junction');
    } catch {
      return;
    }
    installFastRealpath();
    expect(realpathSync(link).toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
  });
});
