import { describe, it, expect } from 'vitest';
import type { FileNode } from '../../../../lib/files';
import { flattenFileTree, filterFiles, workspaceRootPath } from './fileTree';

const tree: FileNode = {
  name: 'proj',
  path: 'C:\\work\\proj',
  kind: 'directory',
  children: [
    { name: 'README.md', path: 'C:\\work\\proj\\README.md', kind: 'file' },
    {
      name: 'src',
      path: 'C:\\work\\proj\\src',
      kind: 'directory',
      children: [
        { name: 'index.ts', path: 'C:\\work\\proj\\src\\index.ts', kind: 'file' },
        { name: 'app.tsx', path: 'C:\\work\\proj\\src\\app.tsx', kind: 'file' },
      ],
    },
  ],
};

describe('fileTree', () => {
  it('workspaceRootPath 归一化为正斜杠无尾斜杠', () => {
    expect(workspaceRootPath(tree)).toBe('C:/work/proj');
  });

  it('flattenFileTree 产出相对路径并跳过根', () => {
    const flat = flattenFileTree(tree);
    const paths = flat.map((f) => f.path).sort();
    expect(paths).toEqual(['README.md', 'src', 'src/app.tsx', 'src/index.ts']);
    expect(flat.find((f) => f.path === 'src')?.isDirectory).toBe(true);
    expect(flat.find((f) => f.path === 'src/index.ts')?.isDirectory).toBe(false);
  });

  it('filterFiles 空查询按深度排序', () => {
    const flat = flattenFileTree(tree);
    const res = filterFiles(flat, '');
    expect(res[0].path).toBe('README.md');
  });

  it('filterFiles 按文件名优先匹配', () => {
    const flat = flattenFileTree(tree);
    const res = filterFiles(flat, 'index');
    expect(res[0].path).toBe('src/index.ts');
  });

  it('filterFiles 支持路径子串匹配', () => {
    const flat = flattenFileTree(tree);
    const res = filterFiles(flat, 'src/app');
    expect(res.map((f) => f.path)).toContain('src/app.tsx');
  });
});
