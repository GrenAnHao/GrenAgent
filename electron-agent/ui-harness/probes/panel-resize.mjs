/**
 * 拖动对话区和右侧面板之间的分隔条：左边长对话、右边文件浏览器打开长 markdown 预览。
 * - 手柄在面板左沿、光标 col-resize；拖多少宽多少，松手后落定尺寸；双击回到初始尺寸。
 * - 拖动中面板没有宽度过渡，松手后恢复，折叠 / 展开仍有 0.2s 动画。
 * - 对话列表滚动时 virtua 照样写 inline pointer-events: none，但计算值一直是 auto（不让整列消息重算样式）。
 * - 帧统计只记录：每 16ms 一个 mousemove 来回拖，long-animation-frame 记长帧。
 *   PANEL_TRACE=1 额外抓 CDP trace 打主线程分项；PANEL_TRACE=invalidation 再打样式失效原因。
 */

const PREVIEW = '[data-testid="file-markdown-preview"]'
const TREE = '[data-testid="file-tree"]'
const HANDLE = '[data-testid="resize-handle-right"]'
const ASIDE = `document.querySelector('[data-testid="right-panel"]').closest('aside')`
const VIRTUA_INNER = `document.querySelector('[data-testid="chat-scroll"]').firstElementChild.firstElementChild`

async function openDoc(t) {
  await t.waitFor(`${TREE} [data-tree-title]`)
  const found = await t.js(`(() => {
    const el = [...document.querySelectorAll('${TREE} [data-tree-title]')].find((n) => n.textContent === 'design.md')
    if (!el) return false
    el.setAttribute('data-probe-node', '1')
    return true
  })()`)
  t.ok('树里有 design.md', found)
  await t.click('[data-probe-node="1"]', 4)
  await t.waitForText(PREVIEW, '设计说明')
}

async function handlePoint(t) {
  return t.js(`(() => {
    const r = document.querySelector('${HANDLE}').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
}

const panelWidth = (t) => t.js(`Math.round(${ASIDE}.getBoundingClientRect().width)`)

/** aside 下 DraggablePanel 外层和 Resizable 的 transition-duration 最大值（秒）。 */
const panelTransition = (t) =>
  t.js(`Math.max(...[...${ASIDE}.querySelectorAll(':scope > div, :scope > div > div')]
    .flatMap((el) => getComputedStyle(el).transitionDuration.split(',').map(parseFloat)))`)

async function startTrace(t) {
  const dbg = t.win.webContents.debugger
  const events = []
  const onMessage = (_e, method, params) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value)
  }
  dbg.on('message', onMessage)
  await dbg.sendCommand('Tracing.start', {
    categories:
      'devtools.timeline,disabled-by-default-devtools.timeline' +
      (process.env.PANEL_TRACE === 'invalidation' ? ',disabled-by-default-devtools.timeline.invalidationTracking' : ''),
    transferMode: 'ReportEvents',
  })
  return async () => {
    const done = new Promise((resolve) => {
      const onDone = (_e, method) => {
        if (method !== 'Tracing.tracingComplete') return
        dbg.off('message', onDone)
        resolve()
      }
      dbg.on('message', onDone)
    })
    await dbg.sendCommand('Tracing.end')
    await done
    dbg.off('message', onMessage)
    return events
  }
}

function summarizeTrace(t, label, events) {
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
  const onMain = events.filter((e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.dur)
  const total = new Map()
  for (const e of onMain) total.set(e.name, (total.get(e.name) ?? 0) + e.dur / 1000)
  const fmt = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, ms]) => `${k}=${Math.round(ms)}`)
      .join(' ')
  t.info(`${label} 主线程合计(ms)`, fmt(total, 12))
  for (const task of onMain.filter((e) => e.name === 'RunTask').sort((a, b) => b.dur - a.dur).slice(0, 3)) {
    const parts = new Map()
    for (const e of onMain) {
      if (e === task || e.ts < task.ts || e.ts + e.dur > task.ts + task.dur) continue
      const d = e.args?.data ?? {}
      const key = e.name === 'FunctionCall' ? `FunctionCall(${d.functionName || 'anon'}@${(d.url || '').split('/').pop()})` : e.name
      parts.set(key, (parts.get(key) ?? 0) + e.dur / 1000)
    }
    t.info(`${label} 长任务 ${Math.round(task.dur / 1000)}ms`, fmt(parts, 8))
  }
  const styles = onMain.filter((e) => e.name === 'UpdateLayoutTree').sort((a, b) => b.dur - a.dur)
  t.info(
    `${label} 最大的样式重算`,
    styles
      .slice(0, 3)
      .map((e) => `${Math.round(e.dur / 1000)}ms/${e.args?.elementCount ?? '?'}元素`)
      .join('  '),
  )
  if (process.env.PANEL_TRACE !== 'invalidation') return
  const reasons = new Map()
  for (const e of events) {
    if (!/Invalidation/.test(e.name)) continue
    const d = e.args?.data ?? {}
    const key = `${e.name}:${d.reason ?? ''}|${d.nodeName ?? ''}`
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }
  t.info(`${label} 失效原因`, fmt(reasons, 10))
}

/** 从手柄起往左拖 span 再拖回来，每 16ms 一个 mousemove，返回帧统计。 */
async function measureDrag(t, label, moves = 90, span = 360) {
  const stopTrace = process.env.PANEL_TRACE ? await startTrace(t) : null
  const from = await handlePoint(t)
  await t.js(`(() => {
    const s = { frames: [], loaf: [], running: true }
    window.__drag = s
    s.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.loaf.push(e.duration)
    })
    s.observer.observe({ type: 'long-animation-frame' })
    const tick = (now) => {
      s.frames.push(now)
      if (s.running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)
  const wc = t.win.webContents
  wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y })
  await t.sleep(50)
  wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= moves; i++) {
    const phase = i / moves
    const offset = phase < 0.5 ? -span * (phase * 2) : -span * (2 - phase * 2)
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + offset), y: from.y, button: 'left', modifiers: ['leftButtonDown'] })
    await t.sleep(16)
  }
  wc.sendInputEvent({ type: 'mouseUp', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  await t.sleep(300)
  const stats = await t.js(`(() => {
    const s = window.__drag
    s.running = false
    s.observer.disconnect()
    const gaps = s.frames.slice(1).map((v, i) => v - s.frames[i]).sort((a, b) => a - b)
    const pick = (p) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] || 0)
    return {
      frames: s.frames.length,
      p95: pick(0.95),
      max: Math.round(gaps[gaps.length - 1] || 0),
      longFrames: s.loaf.length,
      longTotal: Math.round(s.loaf.reduce((a, b) => a + b, 0)),
    }
  })()`)
  if (stopTrace) summarizeTrace(t, label, await stopTrace())
  t.info(label, `帧间隔 p95 ${stats.p95}ms / 最长 ${stats.max}ms，${stats.frames} 帧；长帧 ${stats.longFrames} 个共 ${stats.longTotal}ms`)
  return stats
}

export default async function (t) {
  await t.waitFor('[data-testid="chat-scroll"]')
  await openDoc(t)
  await t.sleep(800)

  // ——— 手柄与尺寸 ———
  const start = await panelWidth(t)
  t.checkNear('初始宽度 1000', start, 1000, 2)
  const p = await handlePoint(t)
  const cursor = await t.js(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); return el ? getComputedStyle(el).cursor : null })()`)
  t.check('面板左沿是拖动手柄、光标 col-resize', cursor, 'col-resize')

  const wc = t.win.webContents
  wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    wc.sendInputEvent({ type: 'mouseMove', x: p.x - i * 20, y: p.y, button: 'left', modifiers: ['leftButtonDown'] })
    await t.sleep(30)
  }
  t.checkNear('拖动中：面板宽度跟着指针（左移 200 → 宽 +200）', await panelWidth(t), start + 200, 2)
  t.check('拖动中：面板外层和 Resizable 没有过渡', await panelTransition(t), 0)
  wc.sendInputEvent({ type: 'mouseUp', x: p.x - 200, y: p.y, button: 'left', clickCount: 1 })
  await t.sleep(300)
  t.checkNear('松手：宽度停在 1200', await panelWidth(t), start + 200, 2)
  t.checkNear('松手：落定尺寸回传给 onResize', (await t.data()).committedWidth, start + 200, 2)
  t.checkNear('松手：恢复 0.2s 过渡', await panelTransition(t), 0.2, 0.01)

  const moved = await handlePoint(t)
  await t.drag(moved, { x: moved.x + 1000, y: moved.y }, 10)
  t.checkNear('往右拖过头：停在最小宽度 360', await panelWidth(t), 360, 2)

  await t.dblclick(HANDLE, 2)
  await t.sleep(400)
  t.checkNear('双击手柄：回到初始宽度 1000', await panelWidth(t), start, 2)
  t.checkNear('双击之后：过渡仍然恢复成 0.2s', await panelTransition(t), 0.2, 0.01)

  // ——— 折叠动画 ———
  const collapse = await t.sample(`Math.round(${ASIDE}.getBoundingClientRect().width)`, 500, () => t.act('expand', false))
  t.ok('折叠：有中间帧', collapse.some((w) => w > 20 && w < start - 20))
  t.checkNear('折叠：收到 0', collapse.at(-1), 0, 2)
  t.check('折叠：手柄不在了', await t.count(HANDLE), 0)
  await t.act('expand', true)
  await t.sleep(500)
  t.checkNear('展开：回到原宽度', await panelWidth(t), start, 2)

  // ——— 对话列表滚动时不整列重算样式 ———
  const pointer = await t.sample(
    `(() => { const el = ${VIRTUA_INNER}; return el.style.pointerEvents + '|' + getComputedStyle(el).pointerEvents })()`,
    400,
    () => t.wheel('[data-testid="chat-scroll"]', -600),
  )
  t.ok('滚动对话：virtua 照常写 inline pointer-events: none', pointer.some((v) => v.startsWith('none|')))
  t.ok('滚动对话：计算值始终是 auto', pointer.every((v) => v.endsWith('|auto')))

  // ——— 帧统计（只记录） ———
  await t.wheel('[data-testid="chat-scroll"]', 20000)
  await t.sleep(400)
  const rounds = []
  for (let i = 1; i <= 3; i++) rounds.push(await measureDrag(t, `对话 + 文件预览 第 ${i} 轮`))
  t.info(
    '对话 + 文件预览 三轮合计',
    `长帧 ${rounds.reduce((s, r) => s + r.longTotal, 0)}ms，p95 ${rounds.map((r) => r.p95).join('/')}ms，最长帧 ${Math.max(...rounds.map((r) => r.max))}ms`,
  )
  t.checkNear('来回拖完：宽度回到原处', await panelWidth(t), start, 4)

  await t.act('show', false, true)
  await t.sleep(400)
  await measureDrag(t, '只有文件预览')
  await t.act('show', true, false)
  await t.sleep(600)
  await measureDrag(t, '只有对话')
  await t.act('show', true, true)
}
