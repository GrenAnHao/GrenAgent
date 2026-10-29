/**
 * 收集生产依赖的许可证文件，供安装包随包分发（electron-builder 的 beforePack → extraResources）。
 *
 * 为什么要有这个脚本：MIT / ISC / BSD / Apache-2.0 都要求分发二进制时附带版权声明与许可文本；
 * EPL-2.0（elkjs）另有「同时提供源代码」的义务；OFL-1.1（Inter 字体）要求随附字体许可。
 * asar 对最终用户不透明，所以把这些文件原样收集到 asar 之外的 resources/licenses/。
 *
 * 打包面与 electron-builder.yml 共用一份清单：files 里以 `!` 开头的 node_modules 排除项
 * 在这里同样生效，避免「包里没有、声明里却有」或反过来。
 *
 * 用法：
 *   node scripts/collect-third-party-licenses.cjs                 # 写 build/licenses/
 *   node scripts/collect-third-party-licenses.cjs --out=<dir>     # 指定输出目录
 *   node scripts/collect-third-party-licenses.cjs --out=<dir> --report=../docs/third-party-dependencies.md
 *   node scripts/collect-third-party-licenses.cjs --check         # 校验已提交的清单是否最新
 */
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');

const appDir = resolve(__dirname, '..');
const repoRoot = resolve(appDir, '..');

/** 许可文件名：LICENSE、LICENSE.md、LICENCE、COPYING、NOTICE、LICENCE-MPL 等。 */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-].*)?$/i;

/** 宽松许可：只需随附声明，无源码或同一许可的附加义务。 */
const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'BlueOak-1.0.0',
]);

function readLockPackages() {
  const lock = JSON.parse(readFileSync(join(appDir, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    if (meta.dev || meta.link) continue;
    const name = key.slice('node_modules/'.length);
    // 嵌套副本（node_modules/a/node_modules/b）按顶层名收集，跳过以免重复。
    if (name.includes('node_modules/')) continue;
    out.push({
      name,
      version: meta.version ?? '',
      license: typeof meta.license === 'string' ? meta.license : 'UNKNOWN',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 从 electron-builder.yml 读 files 里的排除项，与真实打包面保持一致。 */
function packedExclusions() {
  const config = parse(readFileSync(join(appDir, 'electron-builder.yml'), 'utf8'));
  return (config.files ?? [])
    .filter((entry) => typeof entry === 'string' && entry.startsWith('!'))
    .map((entry) => entry.slice(1));
}

function isExcluded(name, exclusions) {
  const path = `node_modules/${name}`;
  return exclusions.some((glob) => {
    const base = glob.replace(/\/\*\*$/, '').replace(/\/$/, '');
    return path === base || path.startsWith(`${base}/`);
  });
}

function licenseFilesOf(packageDir) {
  if (!existsSync(packageDir)) return [];
  return readdirSync(packageDir).filter((entry) => {
    if (!LICENSE_FILE.test(entry)) return false;
    try {
      return statSync(join(packageDir, entry)).isFile();
    } catch {
      return false;
    }
  });
}

function buildInventory() {
  const exclusions = packedExclusions();
  return readLockPackages()
    .filter((entry) => !isExcluded(entry.name, exclusions))
    .map((entry) => ({ ...entry, files: licenseFilesOf(join(appDir, 'node_modules', entry.name)) }));
}

function renderReport(inventory, generatedBy) {
  const byLicense = new Map();
  for (const entry of inventory) {
    if (!byLicense.has(entry.license)) byLicense.set(entry.license, []);
    byLicense.get(entry.license).push(entry);
  }
  const licenses = [...byLicense.keys()].sort((a, b) => byLicense.get(b).length - byLicense.get(a).length);

  const lines = [
    '# 第三方依赖清单',
    '',
    `本文件由 \`${generatedBy}\` 从 \`electron-agent/package-lock.json\` 生成，不要手改。`,
    '只列随安装包分发的生产依赖；开发依赖（vitest、electron-builder、sharp、lightningcss 等）不进包，不在此列。',
    '每个包的许可原文随安装包放在 `resources/licenses/<包名>/`，索引在 `resources/licenses/INDEX.md`。',
    '',
    '## 许可证分布',
    '',
    '| 许可证 | 包数 |',
    '| --- | --- |',
  ];
  for (const license of licenses) lines.push(`| ${license} | ${byLicense.get(license).length} |`);
  lines.push('', '## 需要留意的条目', '');
  lines.push('除下表之外的条目都是宽松许可，随附声明即可。`UNKNOWN` 表示上游 `package.json` 没有 `license` 字段，', '实际许可靠包内许可文件或上游仓库判断，结论见 `docs/third-party-notices.md`。', '');
  lines.push('| 包 | 版本 | 许可证 | 随附许可文件 |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of inventory) {
    if (PERMISSIVE.has(entry.license)) continue;
    const files = entry.files.length ? entry.files.join('、') : '无（包内未附带，见包元数据）';
    lines.push(`| ${entry.name} | ${entry.version} | ${entry.license} | ${files} |`);
  }
  lines.push('', '## 全部生产依赖', '');
  for (const license of licenses) {
    lines.push(`### ${license}`, '');
    for (const entry of byLicense.get(license)) lines.push(`- ${entry.name}@${entry.version}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @param {{ out?: string, report?: string }} options
 */
function collect(options = {}) {
  const outDir = resolve(appDir, options.out ?? 'build/licenses');
  const inventory = buildInventory();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let missing = 0;
  for (const entry of inventory) {
    const destDir = join(outDir, entry.name);
    if (entry.files.length === 0) {
      // 上游没随包发布许可文件：留一条占位，指明许可证标识与出处，便于人工核对。
      mkdirSync(destDir, { recursive: true });
      missing += 1;
      writeFileSync(
        join(destDir, 'LICENSE-MISSING.txt'),
        [
          `${entry.name}@${entry.version}`,
          `声明许可证：${entry.license}`,
          '上游 npm 包内未附带许可文本。',
          `出处：https://www.npmjs.com/package/${entry.name}/v/${entry.version}`,
          '',
        ].join('\n'),
        'utf8',
      );
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    for (const file of entry.files) copyFileSync(join(appDir, 'node_modules', entry.name, file), join(destDir, file));
  }

  // 本仓库自身的许可与第三方来源说明：分发时一并给出。
  copyFileSync(join(repoRoot, 'LICENSE'), join(outDir, 'LICENSE.txt'));
  copyFileSync(join(repoRoot, 'docs', 'third-party-notices.md'), join(outDir, 'third-party-notices.md'));

  const report = renderReport(inventory, 'electron-agent/scripts/collect-third-party-licenses.cjs');
  writeFileSync(join(outDir, 'INDEX.md'), report, 'utf8');

  if (options.report) {
    const reportPath = resolve(appDir, options.report);
    writeFileSync(reportPath, report, 'utf8');
  }

  return { outDir, count: inventory.length, missing };
}

module.exports = { collect, buildInventory, renderReport, packedExclusions };

/** electron-builder 的 beforePack 钩子：打包前把许可证摊到 app 目录下。 */
module.exports.default = async function collectThirdPartyLicenses() {
  const { count, missing } = collect();
  console.log(`third-party licenses: ${count} 个包，其中 ${missing} 个上游未附带许可文本`);
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (flag) => args.find((a) => a.startsWith(`--${flag}=`))?.split('=').slice(1).join('=');
  const generatedBy = 'electron-agent/scripts/collect-third-party-licenses.cjs';

  if (args.includes('--check')) {
    const reportPath = resolve(appDir, '../docs/third-party-dependencies.md');
    const expected = renderReport(buildInventory(), generatedBy);
    const actual = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
    if (actual !== expected) {
      console.error('docs/third-party-dependencies.md 已过期：请运行 node scripts/collect-third-party-licenses.cjs');
      process.exit(1);
    }
    console.log('ok: docs/third-party-dependencies.md 与锁文件一致');
  } else {
    const { outDir, count, missing } = collect({ out: option('out'), report: option('report') });
    console.log(`third-party licenses → ${outDir}：${count} 个包，其中 ${missing} 个上游未附带许可文本`);
  }
}
