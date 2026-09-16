import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const pngToIcoMod = require('png-to-ico');
const pngToIco = typeof pngToIcoMod === 'function' ? pngToIcoMod : pngToIcoMod.default;
const png2icons = require('png2icons');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'build', 'icon.svg');
const PI_BOX = { x: 40, y: 56, w: 160, h: 134 };
const RX_RATIO = 0.3125;
const PAD_SMALL = 0.12;
const PAD_NORMAL = 0.2;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function padFor(size) {
  return size === 16 || size === 24 ? PAD_SMALL : PAD_NORMAL;
}

function buildSvg(size, padRatio, pathD, bg, fg) {
  const inner = size * (1 - 2 * padRatio);
  const scale = Math.min(inner / PI_BOX.w, inner / PI_BOX.h);
  const dx = (size - PI_BOX.w * scale) / 2;
  const dy = (size - PI_BOX.h * scale) / 2;
  const rx = size * RX_RATIO;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${bg}"/>
  <g fill="${fg}" fill-rule="evenodd" transform="translate(${dx} ${dy}) scale(${scale}) translate(${-PI_BOX.x} ${-PI_BOX.y})">
    <path d="${pathD}"/>
  </g>
</svg>`;
}

async function raster(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function mustExist(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`empty icon artifact: ${path}`);
}

async function main() {
  let svg;
  try {
    svg = await readFile(SRC, 'utf8');
  } catch (error) {
    console.error(`missing source SVG: ${SRC}`);
    process.exitCode = 1;
    return;
  }

  const pathD = /<path d="([^"]+)"/.exec(svg)?.[1];
  if (!pathD) {
    console.error(`SVG missing pi path: ${SRC}`);
    process.exitCode = 1;
    return;
  }
  if (!svg.includes('#0b0d12') || !svg.includes('#e6e8ec')) {
    console.error(`SVG missing brand colors: ${SRC}`);
    process.exitCode = 1;
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'gren-icons-'));
  try {
    const pngBySize = new Map();
    pngBySize.set(1024, await raster(svg));
    for (const size of ICO_SIZES) {
      const layerSvg = size <= 24 ? buildSvg(size, padFor(size), pathD, '#0b0d12', '#e6e8ec') : svg;
      pngBySize.set(size, size <= 24 ? await raster(layerSvg) : await sharp(pngBySize.get(1024)).resize(size, size).png().toBuffer());
    }

    const pngDir = join(tmp, 'png');
    await mkdir(pngDir, { recursive: true });
    const icoInputs = [];
    for (const size of ICO_SIZES) {
      const file = join(pngDir, `${size}.png`);
      await writeFile(file, pngBySize.get(size));
      icoInputs.push(file);
    }

    const ico = await pngToIco(icoInputs);
    const favicon = await pngToIco([join(pngDir, '16.png'), join(pngDir, '32.png')]);
    const icns = png2icons.createICNS(pngBySize.get(1024), png2icons.BICUBIC2, 0);
    if (!icns) throw new Error('png2icons.createICNS returned null');

    await writeFile(join(tmp, 'icon.png'), pngBySize.get(1024));
    await writeFile(join(tmp, 'icon.ico'), ico);
    await writeFile(join(tmp, 'icon.icns'), icns);
    await writeFile(join(tmp, 'favicon.ico'), favicon);
    await writeFile(join(tmp, 'favicon.png'), pngBySize.get(32));

    for (const name of ['icon.png', 'icon.ico', 'icon.icns', 'favicon.ico', 'favicon.png']) {
      await mustExist(join(tmp, name));
    }

    await mkdir(join(ROOT, 'build'), { recursive: true });
    await mkdir(join(ROOT, 'public'), { recursive: true });
    await copyFile(join(tmp, 'icon.png'), join(ROOT, 'build', 'icon.png'));
    await copyFile(join(tmp, 'icon.ico'), join(ROOT, 'build', 'icon.ico'));
    await copyFile(join(tmp, 'icon.icns'), join(ROOT, 'build', 'icon.icns'));
    await copyFile(join(tmp, 'favicon.ico'), join(ROOT, 'public', 'favicon.ico'));
    await copyFile(join(tmp, 'favicon.png'), join(ROOT, 'public', 'favicon.png'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
