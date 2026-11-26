import { mkdtempSync, rmSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('electron-agent');
const extensions = resolve('extensions');
const temp = mkdtempSync(join(root, '.visual-ts-overlay-'));
const dist = resolve(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
const { loadExtensions } = await import(pathToFileURL(dist).href);

function copySource(source, destination) {
  for (const item of readdirSync(source)) {
    const src = join(source, item);
    const dest = join(destination, item);
    if (statSync(src).isDirectory()) {
      if (item === 'node_modules') continue;
      copySource(src, dest);
    } else if ((item.endsWith('.ts') && !item.endsWith('.test.ts') && !item.endsWith('.d.ts')) || item.endsWith('.json') || item.endsWith('.md')) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
}

try {
  for (const folder of ['_shared', 'agent-mode', 'visual-companion']) copySource(join(extensions, folder), join(temp, folder));
  const result = await loadExtensions([join(temp, 'agent-mode/index.ts'), join(temp, 'visual-companion/index.ts')], root);
  const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
  const reviewTool = result.extensions.flatMap((extension) => [...extension.tools.values()]).find(({ definition }) => definition.name === 'show_visual')?.definition;
  const askTool = result.extensions.flatMap((extension) => [...extension.tools.values()]).find(({ definition }) => definition.name === 'ask_user')?.definition;
  console.log(JSON.stringify({ errors: result.errors, tools: tools.filter((name) => ['ask_user', 'show_visual', 'read_visual_choice'].includes(name)), showReviewGuidance: reviewTool?.description.includes('visualReview.previewId'), askReviewGuidance: askTool?.description.includes('visualReview.previewId') }));
  if (result.errors.length || !reviewTool || !askTool || !reviewTool.description.includes('visualReview.previewId')) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
// agent-mode watches config after loading; the probe has completed and must not leave a process alive.
process.exit(process.exitCode ?? 0);
