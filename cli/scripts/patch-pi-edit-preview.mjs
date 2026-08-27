/** Keep Pi edit result diffs at five context lines for the desktop preview. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const editDiffPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'core',
  'tools',
  'edit-diff.js',
);

if (!existsSync(editDiffPath)) {
  console.warn('patch-pi-edit-preview: edit-diff.js not found, skip');
  process.exit(0);
}

const source = readFileSync(editDiffPath, 'utf8');
if (source.includes('generateDiffString(oldContent, newContent, contextLines = 5)')) {
  console.log('patch-pi-edit-preview: already patched');
  process.exit(0);
}

const patched = source.replace(
  /generateDiffString\(oldContent, newContent, contextLines = 4\)/,
  'generateDiffString(oldContent, newContent, contextLines = 5)',
);
if (patched === source) {
  console.error('patch-pi-edit-preview: unexpected edit-diff.js shape');
  process.exit(1);
}

writeFileSync(editDiffPath, patched);
console.log('patch-pi-edit-preview: patched', editDiffPath);
