/**
 * 构建依赖图：记下每个场景（和公共入口）依赖了哪些源文件，写到构建产物目录的 deps-graph.json。
 * check.mjs 用它做两件事：
 *  1. 源码没变就不重新构建（逐个对比文件签名），改 probe、重跑失败场景时省掉十几秒构建
 *  2. --changed 时按改动的文件找出受影响的场景（见 affected.mjs）
 *
 * 只在 vite build 时生效。node_modules 里的文件不记。
 * 文件的归属 owners：场景名数组 = 只有这些场景用到；null = 公共（入口 main.tsx 的静态依赖、配置、.env），影响全部场景。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distDir } from './distDir.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// harness.config.mjs 是可选的：早期手写的 harness 没有它，这时 sourceRoots 退回按别名推断
const harnessConfig = await import('./harness.config.mjs').then(
  (module) => module.default ?? {},
  (error) => {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw error
  }
)

export const graphFile = join(distDir, 'deps-graph.json')

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

/** 比较文件路径用的键：正斜杠；Windows / macOS 上不分大小写 */
export function pathKey(file) {
  const normalized = resolve(file).replace(/\\/g, '/')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/** 文件签名：大小 + 修改时间。用「相等」而不是「更新」判断，把旧版本拷回来也能发现 */
export function signature(file) {
  try {
    const stat = statSync(file)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'gone'
  }
}

/**
 * 「变了就必须重建」的标记文件，但它们不属于任何场景（不参与 --changed 的选择）：
 *  - 依赖安装的标记（包管理器每次装完都会改写）。依赖升级不会出现在源码改动里，
 *    靠它发现「node_modules 变了」，否则会拿旧依赖的构建产物跑新依赖的代码
 *  - 本文件：依赖图的格式或记录规则改了，旧的 deps-graph.json 就不可信了
 */
function rebuildMarks() {
  const marks = {
    [fileURLToPath(import.meta.url).replace(/\\/g, '/')]: signature(fileURLToPath(import.meta.url))
  }
  for (let dir = here, prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
    for (const mark of [
      'node_modules/.pnpm/lock.yaml',
      'node_modules/.package-lock.json',
      'node_modules/.yarn-integrity',
      'node_modules/.yarn-state.yml'
    ]) {
      const file = join(dir, mark)
      if (existsSync(file)) marks[file.replace(/\\/g, '/')] = signature(file)
    }
  }
  return marks
}

export function depsGraphPlugin() {
  let startedAt = 0
  let roots = []
  let envFiles = []
  let graph = null

  return {
    name: 'ui-harness-deps-graph',
    apply: 'build',

    configResolved(config) {
      // 渲染层源码根：--changed 用它判断一个改动文件算不算「该有场景覆盖」、样式里的类名算不算项目自己的。
      // 优先用 harness.config.mjs 的 sourceRoots；没配就取别名指向的目录（别名可能指到
      // 主进程扩展这类不属于渲染层的地方，这时必须显式配 sourceRoots）
      const aliases = Array.isArray(config.resolve.alias) ? config.resolve.alias : []
      const fromAlias = aliases.map((entry) => entry.replacement)
      const configured = Array.isArray(harnessConfig.sourceRoots)
        ? harnessConfig.sourceRoots.map((dir) => resolve(here, dir))
        : null
      roots = (configured ?? fromAlias)
        .filter(
          (dir) => typeof dir === 'string' && isAbsolute(dir) && !dir.includes('node_modules')
        )
        .filter((dir) => existsSync(dir))
        .map(pathKey)
      const envDir = config.envDir || here
      envFiles = ['.env', '.env.local', '.env.production', '.env.production.local'].map((name) =>
        join(envDir, name)
      )
    },

    buildStart() {
      startedAt = Date.now()
    },

    generateBundle() {
      const clean = (id) => id.split('?')[0]
      const trackable = (id) =>
        !id.startsWith('\0') && isAbsolute(clean(id)) && !/[\\/]node_modules[\\/]/.test(id)

      /** 从 starts 出发的传递依赖；staticOnly 时只走静态 import（公共入口不含按需加载的场景） */
      const walk = (starts, staticOnly) => {
        const seen = new Set()
        const stack = [...starts]
        while (stack.length > 0) {
          const id = stack.pop()
          if (seen.has(id) || !trackable(id)) continue
          seen.add(id)
          const info = this.getModuleInfo(id)
          if (!info) continue
          stack.push(...info.importedIds)
          if (!staticOnly) stack.push(...info.dynamicallyImportedIds)
        }
        return seen
      }

      const moduleIds = [...this.getModuleIds()]
      const entries = moduleIds.filter((id) => this.getModuleInfo(id)?.isEntry)
      const scenarioDir = `${pathKey(join(here, 'scenarios'))}/`
      const scenarioIds = moduleIds.filter((id) => {
        const key = pathKey(clean(id))
        return (
          trackable(id) &&
          key.startsWith(scenarioDir) &&
          !key.slice(scenarioDir.length).includes('/')
        )
      })

      const files = new Map() // 路径键 → { file, owners: Set | null }
      const note = (id, owner) => {
        const file = resolve(clean(id))
        const key = pathKey(file)
        const entry = files.get(key) ?? { file: file.replace(/\\/g, '/'), owners: new Set() }
        if (owner === null || entry.owners === null) entry.owners = null
        else entry.owners.add(owner)
        files.set(key, entry)
      }

      for (const id of walk(entries, true)) note(id, null)
      const names = []
      for (const id of scenarioIds) {
        const name = basename(clean(id)).replace(/\.[^.]+$/, '')
        names.push(name)
        for (const dep of walk([id], false)) note(dep, name)
      }

      // 不在模块图里、但会影响构建结果的文件：CSS 的 @import、配置、.env、index.html
      // getWatchFiles 是 rollup 的接口，Vite 8（rolldown）没有或者不返回数组，缺了就少记一些额外依赖，不能让构建失败
      const watched = typeof this.getWatchFiles === 'function' ? this.getWatchFiles() : []
      const extras = [
        ...(Array.isArray(watched) ? watched : []),
        ...envFiles,
        join(here, 'vite.config.mjs'),
        join(here, 'harness.config.mjs'),
        join(here, 'index.html')
      ]
      for (const file of extras) {
        // package.json 会被 vite 的解析带进 watch 文件：改个 scripts 不该触发全量，依赖升级靠 installMarks 发现
        if (basename(clean(file)) === 'package.json') continue
        if (trackable(file) && existsSync(file) && !files.has(pathKey(clean(file))))
          note(file, null)
      }

      const entriesOut = {}
      let stale = false
      for (const [key, entry] of files) {
        const sig = signature(entry.file)
        // 构建过程中被改过的文件：这次的产物不一定是它的最新内容，下次一定要重建
        if (Number(sig.split(':')[1]) > startedAt) stale = true
        entriesOut[key] = {
          file: entry.file,
          sig,
          owners: entry.owners === null ? null : [...entry.owners].sort()
        }
      }
      graph = {
        version: 1,
        builtAt: Date.now(),
        stale,
        rebuildMarks: rebuildMarks(),
        roots,
        scenarios: names.sort(),
        files: entriesOut
      }
    },

    writeBundle() {
      if (!graph) return
      mkdirSync(distDir, { recursive: true })
      writeFileSync(graphFile, JSON.stringify(graph))
    }
  }
}

export function readGraph() {
  try {
    const graph = JSON.parse(readFileSync(graphFile, 'utf8'))
    return graph.version === 1 ? graph : null
  } catch {
    return null
  }
}

/**
 * 构建产物是不是还对得上当前源码。
 * 不对的话返回原因（给人看，也让「为什么重建」有据可查）。
 */
export function checkFresh(scenarioNames) {
  if (!existsSync(join(distDir, 'index.html'))) return { fresh: false, reason: '还没有构建产物' }
  const graph = readGraph()
  if (!graph) return { fresh: false, reason: '构建产物没有依赖图（旧版构建）' }
  if (graph.stale) return { fresh: false, reason: '上次构建期间有源文件被改过' }
  if (JSON.stringify(graph.scenarios) !== JSON.stringify([...scenarioNames].sort())) {
    return { fresh: false, reason: '场景有增减' }
  }
  const marksChanged = Object.entries(graph.rebuildMarks ?? {}).some(
    ([file, sig]) => signature(file) !== sig
  )
  if (marksChanged) return { fresh: false, reason: '依赖重新安装过，或 depsGraph.mjs 改过' }
  const changed = Object.values(graph.files).filter((info) => signature(info.file) !== info.sig)
  if (changed.length > 0) {
    const base = resolve(here, '..')
    const sample = changed
      .slice(0, 2)
      .map((info) => relative(base, info.file).replace(/\\/g, '/'))
      .join('、')
    return {
      fresh: false,
      reason: `${changed.length} 个源文件有改动（${sample}${changed.length > 2 ? ' 等' : ''}）`
    }
  }
  return { fresh: true }
}
