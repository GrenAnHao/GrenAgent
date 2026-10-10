import { describe, expect, it } from 'vitest';
import { baseName, detectLineSeparator, extensionOf, fileKindOf, parentDir, pathSegments } from './fileKinds';

describe('fileKinds', () => {
  it('classifies markdown, images and everything else as text', () => {
    expect(fileKindOf('/r/README.md')).toBe('markdown');
    expect(fileKindOf('C:\\r\\notes.MARKDOWN')).toBe('markdown');
    expect(fileKindOf('/r/logo.svg')).toBe('image');
    expect(fileKindOf('/r/a.PNG')).toBe('image');
    expect(fileKindOf('/r/src/main.ts')).toBe('text');
    expect(fileKindOf('/r/Makefile')).toBe('text');
    expect(extensionOf('/r/.gitignore')).toBe('');
  });

  it('detects CRLF from the first line break only', () => {
    expect(detectLineSeparator('a\r\nb\nc')).toBe('\r\n');
    expect(detectLineSeparator('a\nb\r\n')).toBe('\n');
    expect(detectLineSeparator('single line')).toBe('\n');
  });

  it('splits paths for the breadcrumb relative to the workspace root', () => {
    expect(pathSegments('C:\\repo', 'C:\\repo\\src\\a.ts')).toEqual(['src', 'a.ts']);
    expect(pathSegments('/repo/', '/repo/README.md')).toEqual(['README.md']);
    expect(parentDir('/repo/src/a.ts')).toBe('/repo/src');
    expect(baseName('C:\\repo\\src\\a.ts')).toBe('a.ts');
  });
});
