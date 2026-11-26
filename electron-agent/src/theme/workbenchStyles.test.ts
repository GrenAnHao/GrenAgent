// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const src = fileURLToPath(new URL('..', import.meta.url));
const sharedCss = readFileSync(join(src, 'index.css'), 'utf8');
const modeRule = /(?:\[\s*data-theme\s*=\s*['"]?(?:light|dark)['"]?\s*\][^{}`;]*|(?:^|[\s,(&>+~{])(?:html|body|:root)?\.(?:light|dark)(?![\w-])[^{}`;?]*|@media\s*\([^)]*prefers-color-scheme[^)]*\))\s*\{/m;
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

function* styleSources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* styleSources(path);
    else if (['.ts', '.tsx', '.css'].includes(extname(path)) && !/\.(?:test|spec)\./.test(e.name)) yield path;
  }
}

it('uses appearance selectors only to supply root palette variables', () => {
  for (const file of [join(src, 'index.css'), ...styleSources(join(src, 'theme'))]) {
    if (extname(file) !== '.css') continue;
    for (const [, selector, body] of withoutComments(readFileSync(file, 'utf8')).matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      if (!modeRule.test(`${selector}{`)) continue;
      expect(selector.trim(), file).toMatch(/^(?::root|html)(?:\[data-theme=['"](?:light|dark)['"]\]|\.(?:light|dark))$/);
      expect(body.split(';').every(decl => !decl.trim() || decl.trim().startsWith('--')), file).toBe(true);
    }
  }
});

it('keeps component CSS (including CSS-in-JS) independent of appearance', () => {
  // Read source, not modules: no component, renderer or style library is loaded for this check.
  // Runtime palette adapters (e.g. CodeMirror syntax highlighting) are not CSS rules.
  const violations = [];
  for (const dir of ['components', 'features']) {
    for (const file of styleSources(join(src, dir))) {
      const match = withoutComments(readFileSync(file, 'utf8')).match(modeRule);
      if (match) violations.push(`${relative(src, file)}: ${match[0].trim()}`);
    }
  }
  expect(violations).toEqual([]);
});

it('identifies theme classes as CSS selectors, not object properties or class-name prefixes', () => {
  for (const source of ['.light .row {', 'html.dark & {', '&.light:hover {', '.dark button[type="submit"] {', ":root[data-theme='dark'] .row {"]) {
    expect(modeRule.test(source), source).toBe(true);
  }
  for (const source of ['const palette = { ...light };', 'if (palette.dark) {', '.light-toolbar .row {']) {
    expect(modeRule.test(source), source).toBe(false);
  }
});

it('animates surfaces, never the inherited foreground of nested labels and SVGs', () => {
  const rule = sharedCss.match(/html\[data-theme-switching\] \*\s*\{([^}]+)\}/)?.[1];
  const properties = rule?.match(/transition-property:\s*([^;]+)/)?.[1].split(',').map(value => value.trim());
  expect(properties).toEqual(['background-color', 'border-color', 'outline-color']);
});
