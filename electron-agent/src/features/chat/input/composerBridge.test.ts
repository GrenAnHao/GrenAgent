import { afterEach, describe, expect, it, vi } from 'vitest';
import { addFileToComposer, composerFileTagValue, registerComposerInsertFile, type ComposerFileRef } from './composerBridge';

const file = (over: Partial<ComposerFileRef> = {}): ComposerFileRef => ({
  absolute: 'E:\\repo\\src\\app.ts',
  relative: 'src/app.ts',
  workspace: 'E:\\repo',
  name: 'app.ts',
  isDirectory: false,
  ...over,
});

afterEach(() => registerComposerInsertFile(null));

describe('composerFileTagValue', () => {
  it('同一个工作区（含不同写法）用文件管理器给的相对路径', () => {
    expect(composerFileTagValue('E:/repo', file())).toBe('src/app.ts');
  });

  it('会话在别的目录、文件在它下面：相对会话目录', () => {
    expect(composerFileTagValue('E:\\repo\\src', file())).toBe('app.ts');
  });

  it('文件不在会话目录下：给绝对路径', () => {
    expect(composerFileTagValue('D:\\other', file())).toBe('E:\\repo\\src\\app.ts');
    expect(composerFileTagValue('', file({ relative: null }))).toBe('E:\\repo\\src\\app.ts');
  });
});

describe('addFileToComposer', () => {
  it('输入框没挂上时返回 false，挂上后交给它', () => {
    expect(addFileToComposer(file())).toBe(false);
    const insert = vi.fn();
    registerComposerInsertFile(insert);
    expect(addFileToComposer(file())).toBe(true);
    expect(insert).toHaveBeenCalledWith(file());
  });
});
