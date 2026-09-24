import { describe, expect, it } from 'vitest';
import { languageFileName, languageFromPath, languageLabel } from './codeLanguage';

describe('languageLabel', () => {
  it('uses a readable name for a known language', () => {
    expect(languageLabel('typescript')).toBe('TypeScript');
  });

  it('returns the raw id for an unknown language', () => {
    expect(languageLabel('brainfuck')).toBe('brainfuck');
  });

  it('names every language id that languageFromPath can return', () => {
    const samples = ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.py', 'a.go', 'a.rs', 'a.java', 'a.css', 'a.scss', 'a.html', 'a.json', 'a.md', 'a.sh', 'a.ps1', 'a.sql', 'a.yml', 'a.toml', 'a.xml', 'a.vue', 'a.svelte', 'a.c', 'a.cpp', 'a.cs', 'a.txt'];
    for (const sample of samples) {
      const id = languageFromPath(sample);
      expect(languageLabel(id)).not.toBe(id);
      expect(languageFileName(id)).toMatch(/^file\./);
    }
  });
});

describe('languageFileName', () => {
  it('picks a representative file for the icon', () => {
    expect(languageFileName('typescript')).toBe('file.ts');
  });

  it('uses a bare name for an unknown language so the icon stays generic', () => {
    expect(languageFileName('brainfuck')).toBe('file');
  });
});
