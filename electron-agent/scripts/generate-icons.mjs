import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const pngToIcoMod = require('png-to-ico');
const pngToIco = typeof pngToIcoMod === 'function' ? pngToIcoMod : pngToIcoMod.default;
const png2icons = require('png2icons');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'brand', 'source');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const BRAND_START = '<!-- grenagent-brand:start -->';
const BRAND_END = '<!-- grenagent-brand:end -->';

// Source files are the approved, path-only SVGs. Preserve their geometry and transforms verbatim.
function artwork(svg) {
  const viewBox = /\bviewBox="([^"]+)"/.exec(svg)?.[1];
  const dimensions = viewBox?.split(/\s+/).map(Number);
  if (!dimensions || dimensions.length !== 4 || dimensions.some((n) => !Number.isFinite(n)) || dimensions[2] <= 0 || dimensions[3] <= 0) {
    throw new Error('Brand SVG must have a valid viewBox');
  }
  const body = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')).replace(/<title>[\s\S]*?<\/title>/g, '').trim();
  if (!body.includes('<path')) throw new Error('Brand SVG must contain outlined paths');
  return { viewBox, body, width: dimensions[2], height: dimensions[3] };
}

function applicationSvg(size, icon) {
  // Small ICO layers use less surrounding space without changing the approved G outline.
  const pad = size <= 24 ? 0.04 : 0.1;
  const inset = size * pad;
  const inner = size * (1 - 2 * pad);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.21875}" fill="#171819"/>
  <svg x="${inset}" y="${inset}" width="${inner}" height="${inner}" viewBox="${icon.viewBox}" fill="#ffffff">
${icon.body}
  </svg>
</svg>\n`;
}

function bootSvg(logo) {
  const width = 272;
  const height = Number((width * logo.height / logo.width).toFixed(4));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${logo.viewBox}" fill="currentColor" class="boot-brand-logo" aria-hidden="true">
${logo.body}
</svg>`;
}

async function mustExist(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`empty icon artifact: ${path}`);
}

async function main() {
  const icon = artwork(await readFile(join(SOURCE, 'grenagent-icon.svg'), 'utf8'));
  const logo = artwork(await readFile(join(SOURCE, 'grenagent-logo.svg'), 'utf8'));
  const htmlPath = join(ROOT, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const start = html.indexOf(BRAND_START);
  const end = html.indexOf(BRAND_END);
  if (start < 0 || end <= start) throw new Error('index.html is missing the GrenAgent brand generation markers');
  const updatedHtml = html.slice(0, start + BRAND_START.length) + '\n      ' + bootSvg(logo) + '\n      ' + html.slice(end);
  const svg = applicationSvg(1024, icon);

  const tempRoot = resolve(tmpdir());
  const temp = await mkdtemp(join(tempRoot, 'gren-icons-'));
  try {
    const pngBySize = new Map();
    pngBySize.set(1024, await sharp(Buffer.from(svg)).png().toBuffer());
    const pngDir = join(temp, 'png');
    await mkdir(pngDir);
    for (const size of ICO_SIZES) {
      const png = await sharp(Buffer.from(applicationSvg(size, icon))).png().toBuffer();
      pngBySize.set(size, png);
      await writeFile(join(pngDir, `${size}.png`), png);
    }

    const ico = await pngToIco(ICO_SIZES.map((size) => join(pngDir, `${size}.png`)));
    const favicon = await pngToIco([16, 32].map((size) => join(pngDir, `${size}.png`)));
    const icns = png2icons.createICNS(pngBySize.get(1024), png2icons.BICUBIC2, 0);
    if (!icns) throw new Error('png2icons.createICNS returned null');

    await writeFile(join(temp, 'icon.svg'), svg);
    await writeFile(join(temp, 'icon.png'), pngBySize.get(1024));
    await writeFile(join(temp, 'icon.ico'), ico);
    await writeFile(join(temp, 'icon.icns'), icns);
    await writeFile(join(temp, 'favicon.ico'), favicon);
    await writeFile(join(temp, 'favicon.png'), pngBySize.get(32));
    const outputs = [
      ['icon.svg', 'build'], ['icon.png', 'build'], ['icon.ico', 'build'], ['icon.icns', 'build'],
      ['favicon.ico', 'public'], ['favicon.png', 'public'],
    ];
    for (const [name] of outputs) await mustExist(join(temp, name));
    await mkdir(join(ROOT, 'build'), { recursive: true });
    await mkdir(join(ROOT, 'public'), { recursive: true });
    for (const [name, directory] of outputs) await copyFile(join(temp, name), join(ROOT, directory, name));
    await writeFile(htmlPath, updatedHtml);
    console.log('Generated GrenAgent G application icons (PNG/ICO/ICNS), favicon and outlined boot logo from brand/source.');
  } finally {
    // Only remove the private directory created by this invocation, within the resolved OS temp root.
    if (dirname(resolve(temp)) !== tempRoot || !temp.startsWith(join(tempRoot, 'gren-icons-'))) {
      throw new Error(`Refusing cleanup outside the private icon temp directory: ${temp}`);
    }
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
