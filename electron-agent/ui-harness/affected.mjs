/**
 * 改动 → 受影响的场景（check.mjs --changed 用）。
 *
 * 判定依据是 depsGraph.mjs 记下的依赖图，不靠目录名猜：
 *  - 改动文件只被某几个场景引用 → 只跑这几个
 *  - 公共文件（入口静态依赖、Provider、主题、配置）→ 全部
 *  - 全局样式文件（公共，但一次通常只改几条规则）→ 按改动落在哪条规则里、规则选择器里的类名被哪些场景的源码用到，缩小范围
 *  - probes/<场景>.mjs → 那个场景；被 probe 引用的共享断言模块 → 引用它的场景
 *  - run.mjs / probe.mjs（harness 自身）→ 全部
 *  - 渲染层里没人引用的组件 / 样式文件（tsx、jsx、vue、svelte、css）→ 「未覆盖」：该补场景了。
 *    纯 .ts / .js 逻辑文件不提示：它们由单测管，没有场景引用很正常
 *  - 主进程、preload、文档等 harness 看不到的文件 → 忽略
 *
 * 宁可多跑不要漏跑：拿不准的（解析不了、选择器里没有项目里的类名、keyframes / :root 变量）一律退回全部。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pathKey } from './depsGraph.mjs'

// ——— git ———

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return result.error || result.status !== 0 ? null : result.stdout
}

/**
 * 工作区相对 base 的改动（已暂存 + 未暂存 + 未跟踪）。
 * ref 为空：对比 HEAD（本次还没提交的改动）；给了 ref（如 main）：对比它和 HEAD 的共同祖先（整个分支的改动，合并前用）。
 */
export function gitChanges(cwd, ref) {
  const root = git(['rev-parse', '--show-toplevel'], cwd)?.trim()
  if (!root) return { error: '不在 git 仓库里，没法判断改动。直接指定场景名，或不带参数跑全部' }
  let base = 'HEAD'
  if (ref) {
    base = git(['merge-base', ref, 'HEAD'], cwd)?.trim()
    if (!base) return { error: `找不到 ${ref}，或它和 HEAD 没有共同祖先` }
  }
  // ls-files 输出的是相对「当前目录」的路径，而且只列当前目录下的文件：harness 在子目录里时
  // 必须在仓库根目录执行，否则新建的组件 / 场景会拼成错路径、被静默漏掉
  const tracked = git(['diff', '--name-status', '--no-renames', '-z', base], root)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root)
  if (tracked === null || untracked === null)
    return { error: '读 git 改动失败（仓库还没有提交？）' }
  const items = []
  const parts = tracked.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    items.push({ status: parts[i][0], file: resolve(root, parts[i + 1]) })
  }
  for (const file of untracked.split('\0').filter(Boolean)) {
    items.push({ status: 'A', file: resolve(root, file) })
  }
  return { root, base, label: ref ? `${ref}（共同祖先）` : 'HEAD', items }
}

// ——— probe 引用的共享模块 ———

/** 路径键 → 引用它的场景集合。只认相对路径的 import，递归 .mjs/.js */
function probeImportOwners(harnessDir, scenarios) {
  const owners = new Map()
  const importPattern =
    /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g
  for (const name of scenarios) {
    const seen = new Set()
    const visit = (file) => {
      const key = pathKey(file)
      if (seen.has(key) || !existsSync(file)) return
      seen.add(key)
      for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
        const target = resolve(dirname(file), match[1] ?? match[2] ?? match[3])
        const set = owners.get(pathKey(target)) ?? new Set()
        set.add(name)
        owners.set(pathKey(target), set)
        if (/\.[cm]?js$/.test(target)) visit(target)
      }
    }
    visit(join(harnessDir, 'probes', `${name}.mjs`))
  }
  return owners
}

// ——— 全局样式：按规则缩小范围 ———

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|vue|svelte|html)$/i
const CSS_EXT = /\.(css|scss|less)$/i
const GLOBAL_AT_RULE =
  /^@(-\w+-)?(keyframes|font-face|property|counter-style|page|import|charset|namespace)\b/i

/** 把样式文件拆成规则块：{ selector, startLine, endLine, parent }，并标出每一行有没有代码（纯注释 / 空行为 false） */
function parseCss(text, lineComments) {
  const blocks = []
  const stack = []
  const hasCode = []
  let line = 1
  let prelude = ''
  let preludeLine = 0
  let paren = 0
  let i = 0
  const mark = () => {
    hasCode[line] = true
  }
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (let k = i; k < stop; k++) if (text[k] === '\n') line++
      i = stop
      continue
    }
    if (lineComments && c === '/' && next === '/' && text[i - 1] !== ':') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '\n') {
      line++
      if (prelude) prelude += ' '
      i++
      continue
    }
    if (c === '"' || c === "'") {
      let k = i + 1
      while (k < text.length && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1
      if (!preludeLine) preludeLine = line
      prelude += text.slice(i, k + 1)
      mark()
      i = k + 1
      continue
    }
    if (c === '(') paren++
    if (c === ')') paren = Math.max(0, paren - 1)
    if (paren === 0 && c === '{') {
      const block = {
        selector: prelude.trim().replace(/\s+/g, ' '),
        startLine: preludeLine || line,
        endLine: null,
        parent: stack.at(-1) ?? null
      }
      blocks.push(block)
      stack.push(block)
      prelude = ''
      preludeLine = 0
      mark()
    } else if (paren === 0 && c === '}') {
      const block = stack.pop()
      if (block) block.endLine = line
      prelude = ''
      preludeLine = 0
      mark()
    } else if (paren === 0 && c === ';') {
      prelude = ''
      preludeLine = 0
      mark()
    } else if (/\s/.test(c)) {
      if (prelude) prelude += c
    } else {
      if (!preludeLine) preludeLine = line
      prelude += c
      mark()
    }
    i++
  }
  return { blocks, hasCode, balanced: stack.length === 0 }
}

function innermost(blocks, line) {
  let best = null
  let bestDepth = -1
  for (const block of blocks) {
    if (block.startLine > line || line > (block.endLine ?? Infinity)) continue
    let depth = 0
    for (let p = block.parent; p; p = p.parent) depth++
    if (depth > bestDepth) {
      best = block
      bestDepth = depth
    }
  }
  return best
}

function classTokens(selector) {
  const stripped = selector.replace(/\[[^\]]*\]/g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '')
  return [...stripped.matchAll(/[.#]-?[A-Za-z_][\w-]*/g)].map((m) => m[0].slice(1))
}

/** 哪些规则引用了这个动画名（animation / animation-name），返回它们的选择器链 */
function animationUsers(text, blocks, hasCode, name) {
  const pattern = new RegExp(`animation[\\w-]*\\s*:[^;}]*(?<![\\w-])${name}(?![\\w-])`)
  const users = []
  text.split('\n').forEach((content, index) => {
    const line = index + 1
    if (!hasCode[line] || !pattern.test(content)) return
    const chain = []
    for (let b = innermost(blocks, line); b; b = b.parent) {
      if (/^@(-\w+-)?keyframes\b/i.test(b.selector)) return
      if (!b.selector.startsWith('@')) chain.push(b.selector)
    }
    if (chain.length > 0) users.push(chain)
  })
  return users
}

/** 这些行落在哪些规则里：返回规则选择器链，或者「得退回全部」的原因 */
function touchedRules(text, lines, lineComments) {
  const { blocks, hasCode, balanced } = parseCss(text, lineComments)
  if (!balanced) return { global: '样式文件的括号对不上，解析不了' }
  const chains = []
  for (const line of lines) {
    if (!hasCode[line]) continue // 空行、纯注释
    const block = innermost(blocks, line)
    if (!block) return { global: `第 ${line} 行在规则外面（@import / 顶层声明）` }
    const chain = []
    let keyframes = null
    for (let b = block; b; b = b.parent) {
      const frames = /^@(-\w+-)?keyframes\s+([\w-]+)/i.exec(b.selector)
      if (frames) keyframes = frames[2]
      else if (GLOBAL_AT_RULE.test(b.selector))
        return { global: `${b.selector.slice(0, 40)} 的改动影响所有用到它的地方` }
      else if (!b.selector.startsWith('@')) chain.push(b.selector)
    }
    if (keyframes) {
      // 动画关键帧的改动只影响引用它的规则；没人引用（可能在 JS 里用）才退回全部
      const users = animationUsers(text, blocks, hasCode, keyframes)
      if (users.length === 0)
        return { global: `@keyframes ${keyframes} 没有被同一文件里的规则引用` }
      chains.push(...users)
      continue
    }
    chains.push(chain)
  }
  return { chains }
}

/**
 * 改动行号：新文件里新增 / 修改的行 + 旧文件里删掉的行。
 * 纯插入没有旧行、纯删除没有新行，只看有内容的那一侧：删掉的声明在旧文件里属于哪条规则，
 * 新增的声明在新文件里属于哪条规则，不取相邻行（会误选到旁边无关的规则）。
 */
function hunkLines(oldText, newText, diff) {
  if (oldText === null || newText === null || diff === null) {
    const count = (text) => (text === null ? 0 : text.split('\n').length)
    const range = (n) => Array.from({ length: n }, (_, k) => k + 1)
    return { oldLines: range(count(oldText)), newLines: range(count(newText)) }
  }
  const oldLines = []
  const newLines = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [oldStart, oldLen, newStart, newLen] = [
      +m[1],
      m[2] === undefined ? 1 : +m[2],
      +m[3],
      m[4] === undefined ? 1 : +m[4]
    ]
    for (let n = oldStart; n < oldStart + oldLen; n++) oldLines.push(n)
    for (let n = newStart; n < newStart + newLen; n++) newLines.push(n)
  }
  return { oldLines, newLines }
}

function walkSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSources(full, out)
    else if (SOURCE_EXT.test(entry.name) && statSync(full).size < 1_000_000) out.push(full)
  }
  return out
}

/** 类名在哪些源文件里出现：字面量，或 'is-' + x / `cell-${x}` 这类拼出来的前缀 */
function createSourceIndex(graph) {
  let sources = null
  const load = () => {
    if (sources) return sources
    sources = []
    const known = new Set()
    for (const [key, info] of Object.entries(graph.files)) {
      known.add(key)
      if (!SOURCE_EXT.test(info.file) || !existsSync(info.file)) continue
      sources.push({ text: readFileSync(info.file, 'utf8'), owners: info.owners })
    }
    // 渲染层里没被任何场景引用的源码：类名在这里被用到，说明样式属于「没有场景的组件」，不是第三方库的
    for (const root of graph.roots) {
      if (!existsSync(root)) continue
      for (const file of walkSources(root)) {
        if (known.has(pathKey(file))) continue
        sources.push({ text: readFileSync(file, 'utf8'), owners: [] })
      }
    }
    for (const source of sources) {
      source.prefixes = [...source.text.matchAll(/([A-Za-z][\w-]*-)(?=\$\{|["'`]\s*\+)/g)].map(
        (m) => m[1]
      )
    }
    return sources
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    /** → { found, owners: Set | null }；owners 为 null 表示在公共文件里用到，影响全部 */
    lookup(token) {
      const pattern = new RegExp(`(?<![\\w-])${escape(token)}(?![\\w-])`)
      let found = false
      const owners = new Set()
      for (const source of load()) {
        if (!pattern.test(source.text) && !source.prefixes.some((p) => token.startsWith(p)))
          continue
        found = true
        if (source.owners === null) return { found, owners: null }
        for (const name of source.owners) owners.add(name)
      }
      return { found, owners }
    }
  }
}

function cssScenarios({ file, status, repo, sourceIndex }) {
  const rel = relative(repo.root, file).replace(/\\/g, '/')
  const newText = status === 'D' || !existsSync(file) ? null : readFileSync(file, 'utf8')
  const oldText = status === 'A' ? null : git(['show', `${repo.base}:${rel}`], repo.root)
  const diff =
    newText !== null && oldText !== null
      ? git(['diff', '-U0', '--no-color', repo.base, '--', rel], repo.root)
      : null
  const { oldLines, newLines } = hunkLines(oldText, newText, diff)
  const lineComments = /\.(scss|less)$/i.test(file)

  const chains = []
  for (const [text, lines] of [
    [newText, newLines],
    [oldText, oldLines]
  ]) {
    if (text === null || lines.length === 0) continue
    const touched = touchedRules(text, lines, lineComments)
    if (touched.global) return { global: touched.global }
    chains.push(...touched.chains)
  }

  // 只改了空行或注释：不影响任何场景
  if (chains.length === 0) return { scenarios: new Set(), tokens: [], unowned: [], noop: true }

  const scenarios = new Set()
  const tokens = new Set()
  const unowned = new Set()
  for (const chain of chains) {
    const selector = chain.slice().reverse().join(' ')
    const names = [...new Set(chain.flatMap(classTokens))]
    if (names.length === 0)
      return { global: `选择器「${selector.slice(0, 40)}」没有类名，按全部处理` }
    const hits = names
      .map((name) => ({ name, ...sourceIndex.lookup(name) }))
      .filter((hit) => hit.found)
    if (hits.length === 0) {
      return {
        global: `选择器「${selector.slice(0, 40)}」里的类名在项目源码里都找不到（第三方库或动态拼接），按全部处理`
      }
    }
    for (const hit of hits) {
      tokens.add(hit.name)
      if (hit.owners === null) return { global: `类名 ${hit.name} 在公共文件里用到，按全部处理` }
      if (hit.owners.size === 0) unowned.add(hit.name)
      for (const name of hit.owners) scenarios.add(name)
    }
  }
  return { scenarios, tokens: [...tokens], unowned: [...unowned] }
}

// ——— 主入口 ———

const ORCHESTRATION = new Set(['check.mjs', 'depsGraph.mjs', 'affected.mjs', 'distDir.mjs'])
const CORE = new Set(['run.mjs', 'probe.mjs'])
const NOT_COVERABLE = /\.(test|spec)\.[^.]+$|\.d\.ts$|[\\/]__tests__[\\/]/

/**
 * @param changed  [{ status, file }]，file 为绝对路径
 * @param repo     { root, base }，root 用来显示相对路径、取旧版文件
 * @returns { all: string | null, picked: string[], lines: string[], uncovered: string[] }
 */
export function selectScenarios({ changed, graph, scenarios, harnessDir, repo }) {
  const probeOwners = probeImportOwners(harnessDir, scenarios)
  const sourceIndex = createSourceIndex(graph)
  const harnessKey = `${pathKey(harnessDir)}/`
  const picked = new Set()
  const lines = []
  const uncovered = []
  let all = null
  const show = (file) => relative(repo.root, file).replace(/\\/g, '/')
  const markAll = (name, why) => {
    all ??= `${name}：${why}`
    lines.push(`${name} → 全部（${why}）`)
  }
  const add = (name, owners, note = '') => {
    for (const owner of owners) picked.add(owner)
    lines.push(`${name} → ${owners.length > 0 ? owners.join(', ') : '（没有场景用到）'}${note}`)
  }

  for (const { status, file } of changed) {
    const key = pathKey(file)
    const name = show(file)
    const info = graph.files[key]

    if (info && info.owners !== null) {
      add(name, info.owners)
    } else if (info) {
      if (CSS_EXT.test(file)) {
        const css = cssScenarios({ file, status, repo, sourceIndex })
        if (css.global) markAll(name, css.global)
        else {
          if (css.noop) lines.push(`${name} → 忽略（只改了空行或注释）`)
          else {
            const owners = [...css.scenarios].sort()
            const shown = `${css.tokens.slice(0, 4).join('、')}${css.tokens.length > 4 ? ' 等' : ''}`
            const unowned =
              css.unowned.length > 0 ? `；${css.unowned.join('、')} 只被没有场景的组件用到` : ''
            add(name, owners, `（按规则里的类名匹配：${shown}${unowned}）`)
          }
        }
      } else {
        markAll(name, '公共文件')
      }
    } else if (key.startsWith(harnessKey)) {
      // 路径键在 Windows 上是小写的，文件名要从原始路径取，否则和 depsGraph.mjs 这类文件名对不上
      const inside = relative(harnessDir, file).replace(/\\/g, '/')
      const [first, ...rest] = inside.split('/')
      if (rest.length === 0 && CORE.has(first)) markAll(name, 'harness 自身')
      else if (first === 'probes' && rest.length === 1) {
        const scenario = basename(file, extname(file))
        if (scenarios.includes(scenario)) add(name, [scenario])
        else if (status !== 'D') lines.push(`${name} → （没有同名场景）`)
      } else if (probeOwners.has(key))
        add(name, [...probeOwners.get(key)].sort(), '（被这些 probe 引用）')
      else
        lines.push(
          `${name} → 忽略${ORCHESTRATION.has(first) ? '（只影响调度，不影响场景结果）' : ''}`
        )
    } else if (
      status !== 'D' &&
      graph.roots.some((root) => key.startsWith(`${root}/`)) &&
      /\.(tsx|jsx|css|scss|less|vue|svelte)$/i.test(file) &&
      !NOT_COVERABLE.test(file)
    ) {
      uncovered.push(name)
    }
  }

  return { all, picked: [...picked].sort(), lines, uncovered }
}
