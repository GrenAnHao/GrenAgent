/**
 * 构建场景页面（强制生产模式），再逐个场景起一个 Electron 跑对应的 probe。
 *
 * 日常只点名跑当前需求对应的场景。已经定档、不在本次需求里的场景不跑，也不要默认扩散。
 *
 *   node ui-harness/check.mjs foo bar          # 只跑指定场景（新增场景、改了某个场景相关的 UI 或 probe）
 *   node ui-harness/check.mjs --changed --dry-run  # 只看不跑：未提交的改动还波及哪些别的场景
 *   node ui-harness/check.mjs --changed        # 跑受改动影响的场景：只在改了多页共用的代码、确实想验证别的页面时用
 *   node ui-harness/check.mjs --changed=main   # 对比 main：整个分支改的东西影响哪些场景
 *   node ui-harness/check.mjs                  # 全部场景：用户明确要求时才跑
 *   node ui-harness/check.mjs --show           # 显示窗口跑（看过程、量性能），同样不抢焦点
 *   node ui-harness/check.mjs --list           # 列出场景
 *   node ui-harness/check.mjs --rebuild        # 强制重新构建（默认源码没变就复用上次的构建）
 *   node ui-harness/check.mjs --skip-build     # 强制不构建
 *
 * 默认静默：离屏渲染，不弹窗、不抢焦点，跑的时候可以照常用电脑。
 * 任一场景失败，退出码非 0。--changed 没有受影响的场景时什么都不跑、退出码 0，会明说「没有运行任何检查」。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { gitChanges, selectScenarios } from './affected.mjs'
import { checkFresh, readGraph } from './depsGraph.mjs'
import { distDir } from './distDir.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const rebuild = args.includes('--rebuild')
const dryRun = args.includes('--dry-run')
const show = args.includes('--show') || process.env.UI_SHOW === '1'
const changedFlag = args.find((arg) => arg === '--changed' || arg.startsWith('--changed='))
const changedRef = changedFlag?.includes('=') ? changedFlag.slice(changedFlag.indexOf('=') + 1) : ''
const picked = args.filter((arg) => !arg.startsWith('--'))

// 场景从目录里读：scenarios/<名字>.tsx 配 probes/<名字>.mjs，新增场景不用改这个文件
const scenarioDir = join(here, 'scenarios')
const all = existsSync(scenarioDir)
  ? readdirSync(scenarioDir)
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => file.replace(/\.tsx$/, ''))
      .sort()
  : []

if (args.includes('--list')) {
  console.log(all.length > 0 ? all.join('\n') : '（还没有场景）')
  process.exit(0)
}

// 一个场景都没有不算通过：什么都没检查
if (all.length === 0) {
  console.log('scenarios/ 下还没有场景，没有可跑的检查。')
  console.log(
    '先写 scenarios/<名字>.tsx + probes/<名字>.mjs；只想验证 harness 本身，用 skill 的 scripts/smoke.mjs'
  )
  process.exit(1)
}

const unknown = picked.filter((name) => !all.includes(name))
if (unknown.length > 0) {
  console.log(`没有这些场景：${unknown.join(', ')}（scenarios/ 下只有：${all.join(', ')}）`)
  process.exit(1)
}
const noProbe = (picked.length > 0 ? picked : all).filter(
  (name) => !existsSync(join(here, 'probes', `${name}.mjs`))
)
if (noProbe.length > 0) {
  console.log(`这些场景缺少 probes/<名字>.mjs：${noProbe.join(', ')}`)
  process.exit(1)
}

if (dryRun && !changedFlag) {
  console.log('--dry-run 要和 --changed 一起用：它只用来查看改动波及的场景')
  process.exit(1)
}

// --changed 先问 git，不在仓库里就别白构建一次
const repo = changedFlag ? gitChanges(here, changedRef) : null
if (repo?.error) {
  console.log(repo.error)
  process.exit(1)
}

// ——— 构建：源码没变就复用 ———
if (skipBuild) {
  if (!existsSync(join(distDir, 'index.html'))) {
    console.log('没有上一次的构建产物，去掉 --skip-build 再跑')
    process.exit(1)
  }
} else {
  const fresh = rebuild ? { fresh: false, reason: '--rebuild' } : checkFresh(all)
  if (fresh.fresh) {
    console.log('构建产物和源码一致，跳过构建（--rebuild 强制重建）')
  } else {
    console.log(`构建：${fresh.reason}`)
    // 一定要强制生产模式：外部环境里的 NODE_ENV=development 会传染给 vite，
    // 打出开发版 React（StrictMode 双跑 effect、慢 2~3 倍），时序和耗时都不可信
    process.env.NODE_ENV = 'production'
    const { build } = await import('vite')
    const { default: viteConfig } = await import('./vite.config.mjs')
    const started = Date.now()
    await build(viteConfig)
    console.log(`场景已构建（生产模式，${((Date.now() - started) / 1000).toFixed(1)}s）`)
  }
}

// ——— 选场景 ———
let scenarios = picked.length > 0 ? picked : all
let scope = picked.length > 0 ? 'picked' : 'all'
if (repo) {
  const graph = readGraph()
  if (!graph) {
    console.log('没有依赖图，没法按改动选场景。去掉 --skip-build 重新构建一次')
    process.exit(1)
  }
  const changed = repo.items
  const selection = selectScenarios({ changed, graph, scenarios: all, harnessDir: here, repo })
  console.log(`\n对比 ${repo.label}，改动 ${changed.length} 个文件`)
  const shown = selection.lines.slice(0, 14)
  for (const line of shown) console.log(`  ${line}`)
  if (selection.lines.length > shown.length) {
    console.log(`  … 还有 ${selection.lines.length - shown.length} 个文件`)
  }
  if (selection.uncovered.length > 0) {
    console.log(
      `\n没有任何场景覆盖这些改动（新组件 / 新页面请补场景，补完用 check.mjs <场景> 跑）：`
    )
    for (const name of selection.uncovered.slice(0, 10)) console.log(`  ${name}`)
    if (selection.uncovered.length > 10) console.log(`  … 共 ${selection.uncovered.length} 个`)
  }
  const wanted = selection.all ? all : [...new Set([...picked, ...selection.picked])].sort()
  scope = selection.all ? 'all' : 'changed'
  if (wanted.length === 0) {
    console.log('\n没有受影响的场景，没有运行任何检查。')
    process.exit(0)
  }
  scenarios = wanted
  console.log(
    selection.all
      ? `\n影响全部场景（${all.length}）：${selection.all}`
      : `\n受影响的场景 ${wanted.length}/${all.length}：${wanted.join(', ')}`
  )
  if (dryRun) {
    console.log('--dry-run：只列出范围，没有运行任何场景。要跑就去掉 --dry-run，或点名跑其中几个')
    process.exit(0)
  }
}

// 继承下来的 ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node，app 拿不到
const env = { ...process.env, UI_SHOW: show ? '1' : '0' }
delete env.ELECTRON_RUN_AS_NODE
console.log(
  show
    ? '显示窗口运行（--show）：不抢焦点，但鼠标移到测试窗口上会干扰 hover 类断言'
    : '静默运行：离屏渲染，不弹窗、不抢焦点'
)

const failed = []
const started = Date.now()
for (const scenario of scenarios) {
  const result = spawnSync(electronPath, [join(here, 'run.mjs')], {
    stdio: 'inherit',
    env: { ...env, UI_SCENARIO: scenario }
  })
  if (result.status !== 0) failed.push(scenario)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log('')
if (failed.length > 0) {
  console.log(`失败场景：${failed.join(', ')}（${seconds}s）`)
  console.log(`单独复跑确认：node ui-harness/check.mjs ${failed.join(' ')}`)
  process.exit(1)
}
// 结尾写清范围：只跑了一部分时，别让「全部通过」被读成整个项目都验证过
if (scope === 'all' || scenarios.length === all.length) {
  console.log(`全部通过：${scenarios.join(', ')}（${seconds}s）`)
} else {
  const rest = all.length - scenarios.length
  const why = scope === 'changed' ? '不受本次改动影响' : '没指定，未运行'
  console.log(
    `通过：${scenarios.join(', ')}（${seconds}s）。只跑了 ${scenarios.length}/${all.length} 个场景，其余 ${rest} 个${why}`
  )
}
