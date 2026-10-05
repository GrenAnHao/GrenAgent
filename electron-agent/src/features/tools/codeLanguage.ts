const BY_EXT: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  html: 'html',
  java: 'java',
  cjs: 'javascript',
  cts: 'typescript',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  mjs: 'javascript',
  mts: 'typescript',
  md: 'markdown',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'svelte',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

export function languageFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const ext = base.includes('.') ? base.split('.').pop()?.toLowerCase() ?? '' : '';
  return BY_EXT[ext] ?? 'text';
}

const LANGUAGE_META: Record<string, { label: string; fileName: string }> = {
  bash: { label: 'Shell', fileName: 'file.sh' },
  c: { label: 'C', fileName: 'file.c' },
  cpp: { label: 'C++', fileName: 'file.cpp' },
  csharp: { label: 'C#', fileName: 'file.cs' },
  css: { label: 'CSS', fileName: 'file.css' },
  go: { label: 'Go', fileName: 'file.go' },
  html: { label: 'HTML', fileName: 'file.html' },
  java: { label: 'Java', fileName: 'file.java' },
  javascript: { label: 'JavaScript', fileName: 'file.js' },
  json: { label: 'JSON', fileName: 'file.json' },
  jsx: { label: 'JSX', fileName: 'file.jsx' },
  markdown: { label: 'Markdown', fileName: 'file.md' },
  powershell: { label: 'PowerShell', fileName: 'file.ps1' },
  python: { label: 'Python', fileName: 'file.py' },
  rust: { label: 'Rust', fileName: 'file.rs' },
  scss: { label: 'SCSS', fileName: 'file.scss' },
  sql: { label: 'SQL', fileName: 'file.sql' },
  svelte: { label: 'Svelte', fileName: 'file.svelte' },
  text: { label: 'Text', fileName: 'file.txt' },
  toml: { label: 'TOML', fileName: 'file.toml' },
  tsx: { label: 'TSX', fileName: 'file.tsx' },
  typescript: { label: 'TypeScript', fileName: 'file.ts' },
  vue: { label: 'Vue', fileName: 'file.vue' },
  xml: { label: 'XML', fileName: 'file.xml' },
  yaml: { label: 'YAML', fileName: 'file.yaml' },
};

export function languageLabel(language: string): string {
  return LANGUAGE_META[language]?.label ?? language;
}

export function languageFileName(language: string): string {
  return LANGUAGE_META[language]?.fileName ?? 'file';
}
