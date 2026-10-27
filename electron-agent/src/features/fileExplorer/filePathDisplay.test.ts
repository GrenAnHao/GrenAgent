import { describe, expect, it } from 'vitest';
import { displayPath, splitPathForDisplay, summarizePaths } from './filePathDisplay';

describe('displayPath', () => {
  it('相对项目根，用 / 连接；项目根自己写 .', () => {
    expect(displayPath('/repo', '/repo/src/app.ts', 'relative')).toBe('src/app.ts');
    expect(displayPath('C:\\repo', 'C:\\repo\\src\\app.ts', 'relative')).toBe('src/app.ts');
    expect(displayPath('/repo', '/repo', 'relative')).toBe('.');
  });

  it('绝对路径原样给；不在项目根下或根未知时也给绝对路径', () => {
    expect(displayPath('/repo', '/repo/src/app.ts', 'absolute')).toBe('/repo/src/app.ts');
    expect(displayPath('/repo', '/other/a.ts', 'relative')).toBe('/other/a.ts');
    expect(displayPath(null, '/repo/a.ts', 'relative')).toBe('/repo/a.ts');
  });
});

describe('splitPathForDisplay', () => {
  it('目录带结尾分隔符，文件名单独拆出', () => {
    expect(splitPathForDisplay('src/features/a.ts')).toEqual({ dir: 'src/features/', name: 'a.ts' });
    expect(splitPathForDisplay('C:\\repo\\a.ts')).toEqual({ dir: 'C:\\repo\\', name: 'a.ts' });
    expect(splitPathForDisplay('README.md')).toEqual({ dir: '', name: 'README.md' });
  });
});

describe('summarizePaths', () => {
  it('空、单项、多项', () => {
    expect(summarizePaths('/repo', [], 'relative')).toEqual({ text: '', full: '', copy: '', count: 0 });
    expect(summarizePaths('/repo', ['/repo/a.ts'], 'relative')).toEqual({ text: 'a.ts', full: 'a.ts', copy: 'a.ts', count: 1 });
    const many = summarizePaths('/repo', ['/repo/a.ts', '/repo/b/c.ts'], 'relative');
    expect(many).toMatchObject({ text: '已选 2 项', full: 'a.ts\nb/c.ts', copy: 'a.ts\nb/c.ts', count: 2 });
  });

  it('悬停提示最多列 10 项，复制给全部', () => {
    const paths = Array.from({ length: 13 }, (_, i) => `/repo/f${i}.ts`);
    const summary = summarizePaths('/repo', paths, 'relative');
    expect(summary.full.split('\n')).toHaveLength(11);
    expect(summary.full.endsWith('… 另有 3 项')).toBe(true);
    expect(summary.copy.split('\n')).toHaveLength(13);
  });
});
