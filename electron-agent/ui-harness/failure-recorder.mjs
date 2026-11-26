import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClickReadyError } from './clickReady.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const finite = Number.isFinite
const pointOf = (p) => p && finite(p.x) && finite(p.y) ? { x: p.x, y: p.y } : null
const iso = () => new Date().toISOString()

// 只从本地 harness 调用位置取证，不把堆栈、任意异常 message 或动态标签写入附件。
function sourceSite(stack, dir) {
  for (const match of String(stack ?? '').slice(0, 8192).matchAll(/(file:\/\/\/[^\n\r)]+?):(\d+):(\d+)\)?(?:\n|$)/g)) {
    let file
    try { file = fileURLToPath(match[1]) } catch { continue }
    const path = relative(dir, file).split(sep).join('/')
    if (!path.endsWith('.mjs') || path.startsWith('..') || isAbsolute(path) || /^(?:probe|run|failure-recorder)\.mjs$/.test(path)) continue
    return { file: path, line: Number(match[2]), column: Number(match[3]) }
  }
  return null
}

function shortValue(value) {
  if (value === null || typeof value === 'boolean' || finite(value)) return value
  if (typeof value === 'string') {
    if (/^(?:block|none|flex|grid|hidden|visible|inline|auto|true|false|rgba?\([0-9.,%\s]{3,40}\)|-?\d{1,6}(?:\.\d{1,4})?px)$/.test(value)) return value
    return { type: 'string', length: value.length }
  }
  return Array.isArray(value) ? { type: 'array', length: value.length } : { type: typeof value }
}

// This function is serialized into the synthetic window; do not capture ambient JS values.
export function installFailureObserver() {
  if (window.__uiFailureObservation) return
  const node = (el) => {
    if (!(el instanceof Element)) return null
    const tag = el.localName.slice(0, 16) // Filter against the tag allowlist before writing.
    const testId = el.getAttribute('data-testid')
    let sibling = 1, inspected = 0
    for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
      if (++inspected > 32) { sibling = null; break }
      if (prev.localName === el.localName) sibling++
    }
    return { tag, sibling, testId: /^[a-z][a-z0-9-]{0,63}$/.test(testId ?? '') ? testId : null }
  }
  const now = () => Math.round(performance.timeOrigin + performance.now())
  let lastMouseDown = null, lastPasteAt = null
  document.addEventListener('mousedown', (event) => {
    if (!event.isTrusted) return
    lastMouseDown = { at: now(), point: { x: event.clientX, y: event.clientY }, target: node(event.composedPath()[0]) }
  }, { capture: true, passive: true })
  document.addEventListener('paste', () => { lastPasteAt = now() }, { capture: true, passive: true })
  window.__uiFailureObservation = () => ({ at: now(), focus: node(document.activeElement), lastMouseDown, lastPasteAt })
}

function observation(value, probeSource) {
  if (!value) return { status: 'observer-unavailable' }
  const node = (v) => {
    if (!v) return null
    const id = v.testId
    // Retain the ID only if it also occurs in a literal test selector authored by the probe.
    const known = typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id) &&
      ['"', "'"].some(q => probeSource.includes('[data-testid=' + q + id + q + ']'))
    const tag = /^(?:a|article|aside|body|button|code|dialog|div|element|fieldset|form|g|h[1-6]|header|html|img|input|label|li|main|nav|ol|option|p|path|pre|section|select|span|svg|table|tbody|td|textarea|th|thead|tr|ul)$/.test(v.tag) ? v.tag : 'element'
    return { tag, sibling: Number.isInteger(v.sibling) ? v.sibling : null, ...(known ? { testId: id } : {}) }
  }
  const down = value.lastMouseDown
  return { status: 'available', at: finite(value.at) ? value.at : null, focus: node(value.focus),
    lastPasteAt: finite(value.lastPasteAt) ? value.lastPasteAt : null,
    lastMouseDown: down ? { at: finite(down.at) ? down.at : null, point: pointOf(down.point), target: node(down.target) } : null }
}

export function createFailureRecorder({ scenario, root, getWindow, screenshot = true, budgetMs = 1200, log = console.log }) {
  let seq = 0
  const steps = []
  const started = performance.now()
  let first, pending, directory
  function step(kind, point) {
    if (first) return
    const where = pointOf(point)
    steps.push({ seq: ++seq, ms: Math.round(performance.now() - started), kind, ...(where ? { point: where } : {}) })
    if (steps.length > 32) steps.shift()
  }
  const readSource = (path) => {
    try { return readFileSync(join(here, path), 'utf8') } catch { return '' }
  }
  function fail(kind, { label, actual, expected, tolerance, error } = {}) {
    if (first) return
    first = { kind, at: iso(), stepSeq: seq }
    const site = sourceSite(error?.stack ?? new Error().stack, here)
    if (site) first.site = site
    if (kind === 'assertion') {
      // A literal at this exact call site is authored documentation. Template labels,
      // data-derived strings and objects are never copied into JSON.
      const line = site && readSource(site.file).split(/\r?\n/)[site.line - 1]
      const literal = line && /\.(?:check|ok|checkNear|checkColor)\(\s*(["'])([^"'\\]{1,120})\1\s*,/.exec(line)?.[2]
      first.label = label === literal && literal ? literal : shortValue(label)
      first.actual = shortValue(actual)
      first.expected = shortValue(expected)
      if (finite(tolerance)) first.tolerance = tolerance
    }
    if (error instanceof ClickReadyError) first.clickReady = error.details
    else if (error) {
      first.error = ['Error','TypeError','SyntaxError','RangeError','ReferenceError'].includes(error.name) ? error.name : 'Error'
      // Keep authored exceptions useful; dynamic messages have only type/length and site.
      const line = site && readSource(site.file).split(/\r?\n/)[site.line - 1]
      const literal = line && /throw new \w*Error\(\s*(["'])([^"'\\]{1,120})\1\s*\)/.exec(line)?.[2]
      first.message = literal && error.message === literal ? literal : shortValue(error.message)
    }
    const snapshot = { version: 1, scenario, first, steps: steps.slice(),
      window: { status: 'pending' }, screenshot: { status: screenshot ? 'pending' : 'disabled' } }
    try {
      mkdirSync(root, { recursive: true })
      directory = join(mkdtempSync(join(root, 'run-')), basename(scenario))
      mkdirSync(directory)
      writeFileSync(join(directory, 'failure.json'), JSON.stringify(snapshot, null, 2))
    } catch (err) {
      log('  失败现场不可写（' + (err?.code ?? 'I/O') + '），首错：' + kind)
      return
    }
    log('  失败现场：' + directory)
    const win = getWindow()
    const wc = win && !win.isDestroyed() ? win.webContents : null
    // Launch both immediately, before control returns to the probe. One real deadline;
    // late data cannot replace a missing or earlier observation.
    const capture = async (key, fn) => {
      let timer
      try {
        if (!wc || wc.isDestroyed()) { snapshot[key] = { status: 'window-unavailable' }; return }
        const result = await Promise.race([
          fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(TIMEOUT), budgetMs) })
        ])
        if (key === 'window') {
          snapshot.window = observation(result, readSource('probes/' + basename(scenario) + '.mjs'))
        } else {
          if (result.isEmpty()) throw new Error('empty')
          writeFileSync(join(directory, 'window.png'), result.toPNG())
          snapshot.screenshot = { status: 'available', file: 'window.png', at: iso() }
        }
      } catch (err) { snapshot[key] = { status: err === TIMEOUT ? 'timed-out' : 'unavailable' } }
      finally { clearTimeout(timer) }
    }
    pending = Promise.all([
      capture('window', () => wc.executeJavaScript('window.__uiFailureObservation?.() ?? null')),
      ...(screenshot ? [capture('screenshot', () => wc.capturePage())] : [])
    ]).then(() => {
      try { writeFileSync(join(directory, 'failure.json'), JSON.stringify(snapshot, null, 2)) }
      catch (err) { log('  失败现场更新不可写（' + (err?.code ?? 'I/O') + '），首错：' + kind) }
    })
  }
  return { step, fail, settle: () => pending, get directory() { return directory } }
}

const TIMEOUT = Symbol('capture deadline')
