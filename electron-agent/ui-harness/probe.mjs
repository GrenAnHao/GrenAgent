/**
 * probe 的工具箱 t：真实输入、读 DOM、断言、采样。
 * 每个 probes/<名字>.mjs 默认导出 async (t) => { ... }。
 *
 * 所有交互都走 webContents.sendInputEvent，不走 element.click() / dispatchEvent：
 * 表格的焦点管理、弹层的 outside-click、拖选、hover 只认浏览器级别的真实事件。
 * sendInputEvent 把事件直接送进渲染进程，不动系统光标、不需要系统焦点，静默模式下一样生效。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shotDir } from './distDir.mjs'

/** 点击 / 按键后的等待：弹层动画 + 框架 commit */
const SETTLE = 350

const q = (value) => JSON.stringify(value)

/**
 * 颜色是否相近：合成和色彩配置会让取整飘 1~4 个值，写死 rgb() 会假失败。
 * 通道容差默认 ±4，alpha 容差 ±0.02。只认 rgb() / rgba()。
 */
export function colorNear(actual, expected, tolerance = 4) {
  const parse = (value) => {
    const match =
      /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*([\d.]+))?\)/.exec(
        String(value)
      )
    if (!match) return null
    return [1, 2, 3, 4].map((i) => (match[i] === undefined ? 1 : Number(match[i])))
  }
  const left = parse(actual)
  const right = parse(expected)
  if (!left || !right) return false
  return left.every((channel, i) => Math.abs(channel - right[i]) <= (i === 3 ? 0.02 : tolerance))
}

/**
 * 把视口（innerWidth / innerHeight）调到正好 width × height。
 * 离屏渲染时视口会比 setContentSize 的值大一两个像素，按实测差值补回去，最多调三次。
 */
export async function fitViewport(win, width, height) {
  const wc = win.webContents
  for (let i = 0; i < 3; i++) {
    const [w, h] = await wc.executeJavaScript('[innerWidth, innerHeight]')
    if (w === width && h === height) return
    const [cw, ch] = win.getContentSize()
    win.setContentSize(Math.max(1, cw + width - w), Math.max(1, ch + height - h))
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

export function createProbe(win, scenario, config = {}) {
  const wc = win.webContents
  /** --show 显示窗口跑时为 true；默认静默（离屏渲染）为 false */
  const visible = process.env.UI_SHOW === '1'
  const js = (code) => wc.executeJavaScript(code)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let passed = 0
  let failed = 0
  let sampleSeq = 0

  // ——— 等待 ———

  /** 等选择器出现在 DOM 里。超时返回 false 并打一行 MISS（不算失败，后面的断言会说明问题） */
  async function waitFor(sel, timeout = 5000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await js(`!!document.querySelector(${q(sel)})`)) return true
      await sleep(100)
    }
    console.log(`  MISS waitFor ${sel}`)
    return false
  }

  /** 等页面里的一个 JS 表达式为真，例如 "document.querySelectorAll('.row').length >= 20" */
  async function waitUntil(expr, timeout = 5000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await js(`!!(${expr})`)) return true
      await sleep(100)
    }
    console.log(`  MISS waitUntil ${expr}`)
    return false
  }

  /** 等选择器的 textContent 包含指定文字 */
  async function waitForText(sel, text, timeout = 5000) {
    return waitUntil(
      `(document.querySelector(${q(sel)})?.textContent ?? '').includes(${q(text)})`,
      timeout
    )
  }

  // ——— 读 DOM ———

  const text = (sel) => js(`document.querySelector(${q(sel)})?.textContent ?? null`)
  const texts = (sel) => js(`[...document.querySelectorAll(${q(sel)})].map((el) => el.textContent)`)
  const html = (sel) => js(`document.querySelector(${q(sel)})?.innerHTML ?? null`)
  const count = (sel) => js(`document.querySelectorAll(${q(sel)}).length`)

  /**
   * 只数真正看得见的匹配项。很多组件库关掉弹层后内容还留在 DOM 里，
   * 用 count 数会把关掉的那份也算上，断言就成了「关不掉」。
   * 排除：display:none、visibility:hidden、opacity:0（含祖先）、落在 config.hiddenSelector 里。
   */
  const countVisible = (sel) =>
    js(`(() => {
      const hidden = ${q(config.hiddenSelector ?? '')}
      return [...document.querySelectorAll(${q(sel)})].filter((el) => {
        if (hidden && el.closest(hidden)) return false
        if (typeof el.checkVisibility === 'function') {
          return el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        }
        return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      }).length
    })()`)

  /**
   * 读计算样式。props 写 kebab-case（'clip-path'），返回对象的 key 是 camelCase（clipPath）。
   * pseudo 可选 '::before' / '::after'。元素不存在返回 null。
   */
  const style = (sel, props, pseudo) =>
    js(`(() => {
      const el = document.querySelector(${q(sel)})
      if (!el) return null
      const s = getComputedStyle(el${pseudo ? `, ${q(pseudo)}` : ''})
      return Object.fromEntries(${q(props)}.map((k) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), s.getPropertyValue(k)]))
    })()`)

  /** 元素的视口矩形 { x, y, w, h, right, bottom }（取整）；不存在返回 null */
  const rect = (sel) =>
    js(`(() => {
      const el = document.querySelector(${q(sel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }
    })()`)

  /** 元素左沿 + dx、垂直居中处的坐标（dx 默认 6：点在文字上，而不是格子空白处） */
  const at = (sel, dx = 6) =>
    js(`(() => {
      const el = document.querySelector(${q(sel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + ${dx}), y: Math.round(r.y + r.height / 2) }
    })()`)

  /** 元素中心坐标 */
  const center = (sel) =>
    js(`(() => {
      const el = document.querySelector(${q(sel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)

  /**
   * 等位置稳定再取坐标。弹层进场、列表填充都会让 rect 动几十毫秒，
   * 按动画中途的坐标点下去会点空（表现成「没触发点击」）。
   */
  async function atStable(sel, dx = 6, tries = 12) {
    let prev = null
    for (let i = 0; i < tries; i++) {
      const point = await at(sel, dx)
      if (point && prev && point.x === prev.x && point.y === prev.y) return point
      prev = point
      await sleep(50)
    }
    return prev
  }

  /** 坐标处最上层的元素是不是 sel 自己或其后代（判断有没有被遮住、能不能点到） */
  const hitTest = (sel) =>
    js(`(() => {
      const el = document.querySelector(${q(sel)})
      if (!el) return false
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return !!hit && el.contains(hit)
    })()`)

  async function resolvePoint(selOrPoint, dx, label) {
    const point = typeof selOrPoint === 'string' ? await atStable(selOrPoint, dx) : selOrPoint
    if (!point)
      console.log(`  MISS ${label} ${typeof selOrPoint === 'string' ? selOrPoint : q(selOrPoint)}`)
    return point
  }

  // ——— 输入（真实事件） ———

  /**
   * 单击。selOrPoint 是选择器或 { x, y }；modifiers 如 ['control'] / ['shift'] / ['meta']。
   * 点完把鼠标挪到 (2,2)，免得后面读到 hover 态。点不到返回 null 并打 MISS。
   */
  async function click(selOrPoint, dx = 6, modifiers = []) {
    const p = await resolvePoint(selOrPoint, dx, 'click')
    if (!p) return null
    wc.sendInputEvent({
      type: 'mouseDown',
      x: p.x,
      y: p.y,
      button: 'left',
      clickCount: 1,
      modifiers
    })
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers })
    await sleep(SETTLE)
    wc.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
    await sleep(80)
    return p
  }

  /** 双击（两次按下/抬起，第二次 clickCount 2，浏览器才会发 dblclick） */
  async function dblclick(selOrPoint, dx = 6) {
    const p = await resolvePoint(selOrPoint, dx, 'dblclick')
    if (!p) return null
    for (const clickCount of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount })
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount })
    }
    await sleep(SETTLE)
    wc.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
    await sleep(80)
    return p
  }

  /** 右键（打开上下文菜单） */
  async function rightClick(selOrPoint, dx = 6) {
    const p = await resolvePoint(selOrPoint, dx, 'rightClick')
    if (!p) return null
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 })
    await sleep(SETTLE)
    return p
  }

  /** 移上去停住（量 hover 态 / 触发悬停弹层）。不点，也不挪开 */
  async function hover(selOrPoint, dx = 6) {
    const p = await resolvePoint(selOrPoint, dx, 'hover')
    if (!p) return null
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    await sleep(240)
    return p
  }

  /** 把鼠标挪到视口坐标；mouse(2, 2) 就是挪开、清掉 hover 态 */
  async function mouse(x, y) {
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    await sleep(220)
  }

  /** 按住拖到终点，中途发 steps 个 mousemove（拖选多格、拖拽排序、拖分隔条） */
  async function drag(from, to, steps = 8) {
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      wc.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(from.x + ((to.x - from.x) * i) / steps),
        y: Math.round(from.y + ((to.y - from.y) * i) / steps),
        button: 'left'
      })
      await sleep(30)
    }
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 })
    await sleep(400)
  }

  /** 在元素上滚滚轮。deltaY > 0 向下滚（像素） */
  async function wheel(selOrPoint, deltaY, deltaX = 0) {
    const p = typeof selOrPoint === 'string' ? await center(selOrPoint) : selOrPoint
    if (!p) {
      console.log(`  MISS wheel ${typeof selOrPoint === 'string' ? selOrPoint : q(selOrPoint)}`)
      return null
    }
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    // Chromium 的滚轮事件里正值是「向上 / 向左」，这里翻过来，调用方按直觉写
    wc.sendInputEvent({
      type: 'mouseWheel',
      x: p.x,
      y: p.y,
      deltaX: -deltaX,
      deltaY: -deltaY,
      canScroll: true
    })
    await sleep(SETTLE)
    return p
  }

  /**
   * 按一个键。keyCode 用 Electron 的键名：'Escape'、'Return'（回车）、'Tab'、'Up'、'Down'、
   * 'Left'、'Right'、'Backspace'、'Delete'、'Space'、'a'……；modifiers 如 ['shift']、['control']。
   */
  async function key(keyCode, modifiers = []) {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1 && modifiers.length === 0) wc.sendInputEvent({ type: 'char', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(SETTLE)
  }

  /** 逐字敲 ASCII（每个字符一次 char 事件，触发 keypress / input） */
  async function type(chars) {
    for (const ch of chars) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(50)
    }
    await sleep(SETTLE)
  }

  /** 往焦点元素里插入一段文字（中文、长文本用这个，走真实的 beforeinput / input） */
  async function insertText(value) {
    await wc.insertText(value)
    await sleep(SETTLE)
  }

  // ——— 场景通道（见 stubs.ts） ———

  /** 场景用 exposeData 暴露的数据（window.__uiData） */
  const data = () => js('window.__uiData ?? {}')

  /** 场景用 track() 记下的事件列表（window.__uiEvents） */
  const events = () => js('window.__uiEvents ?? []')

  /** 调场景用 exposeActions 暴露的操作，返回值可结构化克隆时原样带回 */
  const act = (name, ...args) =>
    js(`(async () => {
      const fn = window.__uiActions?.[${q(name)}]
      if (typeof fn !== 'function') throw new Error('没有这个场景操作：' + ${q(name)})
      const result = await fn(...${q(args)})
      try { return structuredClone(result) } catch { return null }
    })()`)

  // ——— 窗口、主题、截图 ———

  /** 切主题：只改 <html> 上的属性（默认 data-theme）。等 450ms，带 transition 的颜色等短了会读到中间色 */
  async function setTheme(theme, attribute = 'data-theme') {
    await js(`document.documentElement.setAttribute(${q(attribute)}, ${q(theme)})`)
    await sleep(450)
  }

  /** 把视口改成正好 width × height（量窄窗口布局），返回原视口 [w, h]，用完记得改回去 */
  async function resize(width, height) {
    const before = await js('[innerWidth, innerHeight]')
    await fitViewport(win, width, height ?? before[1])
    await sleep(200)
    return before
  }

  /** 截当前窗口到临时目录，路径打到 INFO 里，人工复核外观用 */
  async function shot(name) {
    mkdirSync(shotDir, { recursive: true })
    const file = join(shotDir, `${scenario}-${name}.png`)
    writeFileSync(file, (await wc.capturePage()).toPNG())
    info(`截图 ${name}`, file)
    return file
  }

  // ——— 采样 ———

  /**
   * 逐帧采样：先在页面里起一个 rAF 循环，每帧求一次 expr（页面里的 JS 表达式），
   * 再执行 trigger（例如点一下折叠按钮），ms 毫秒后返回所有帧的值。
   * 用来断言过渡动画「有中间帧、单调、终点对」，而不是只看起点终点。
   */
  async function sample(expr, ms = 600, trigger) {
    const id = `__uiSample${++sampleSeq}`
    await js(`(() => {
      const out = []
      window.${id} = { out, done: false }
      const t0 = performance.now()
      const tick = () => {
        out.push((() => (${expr}))())
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick)
        else window.${id}.done = true
      }
      requestAnimationFrame(tick)
    })()`)
    if (trigger) await trigger()
    await waitUntil(`window.${id}.done`, ms + 5000)
    return js(`window.${id}.out`)
  }

  /**
   * 连续滚动一个滚动容器 ms 毫秒（来回滚），返回 fps。
   * 只用 info 记录，不做断言：同机负载会让它抖 ±30%。
   * 静默模式下帧率封顶为主显示器刷新率（或 config.frameRate），但离屏渲染的耗时和真实上屏不同，
   * 要对比性能用 --show 跑。
   */
  async function scrollFps(sel, ms = 2000, speed = 8) {
    const id = `__uiFps${++sampleSeq}`
    await js(`(() => {
      window.${id} = null
      const vp = document.querySelector(${q(sel)})
      if (!vp) { window.${id} = -1; return }
      const max = vp.scrollHeight - vp.clientHeight
      let dir = 1, last = performance.now(), frames = 0, total = 0
      const tick = (now) => {
        const dt = now - last; last = now; frames++; total += dt
        let next = vp.scrollTop + dir * ${speed} * (dt / 16.7)
        if (next >= max) { next = max; dir = -1 } else if (next <= 0) { next = 0; dir = 1 }
        vp.scrollTop = next
        if (total > ${ms}) { window.${id} = Math.round(frames / (total / 1000)); return }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })()`)
    await waitUntil(`window.${id} !== null`, ms + 5000)
    return js(`window.${id}`)
  }

  // ——— 断言 ———

  function record(pass, label, detail) {
    if (pass) {
      passed++
      console.log(`  PASS ${label}`)
    } else {
      failed++
      console.log(`  FAIL ${label}  ${detail}`)
    }
    return pass
  }

  /** 相等断言。对象 / 数组按 JSON 比较（key 顺序也要一致） */
  function check(label, actual, expected) {
    const same =
      typeof expected === 'object' && expected !== null
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : actual === expected
    return record(same, label, `got ${q(actual)}  want ${q(expected)}`)
  }

  /** 真值断言 */
  function ok(label, value) {
    return record(!!value, label, `got ${q(value)}`)
  }

  /** 数值近似断言（高分屏下 28px 可能量成 27.33） */
  function checkNear(label, actual, expected, tolerance = 1) {
    const pass = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
    return record(pass, label, `got ${q(actual)}  want ${expected}±${tolerance}`)
  }

  /** 颜色断言：按通道容差比 */
  function checkColor(label, actual, expected, tolerance = 4) {
    return record(colorNear(actual, expected, tolerance), label, `got ${actual}  want≈${expected}`)
  }

  /** 只记录不判定（fps、尺寸链、调试信息） */
  function info(label, value) {
    console.log(`  INFO ${label}  ${typeof value === 'string' ? value : q(value)}`)
  }

  return {
    scenario,
    win,
    config,
    visible,
    js,
    sleep,
    waitFor,
    waitUntil,
    waitForText,
    text,
    texts,
    html,
    count,
    countVisible,
    style,
    rect,
    at,
    center,
    atStable,
    hitTest,
    click,
    dblclick,
    rightClick,
    hover,
    mouse,
    drag,
    wheel,
    key,
    type,
    insertText,
    data,
    events,
    act,
    setTheme,
    resize,
    shot,
    sample,
    scrollFps,
    check,
    ok,
    checkNear,
    checkColor,
    colorNear,
    info,
    get passed() {
      return passed
    },
    get failed() {
      return failed
    }
  }
}
