import { createRequire } from 'node:module';

// Match the exact KaTeX that renders Lobe Markdown, even in a multi-version pnpm tree.
const lobe = createRequire(createRequire(import.meta.url).resolve('@lobehub/ui'));
export const rendererAssetAliases = { '@lobe-katex.css': lobe.resolve('katex/dist/katex.min.css') };
