/**
 * 视觉设计面板：没有底部确认条；长页滚到底依然可以点选项 B。
 * 选项只负责展示，不能从 iframe 回传评审答案。
 *
 * 沙箱 iframe（srcdoc、没有 allow-same-origin）是独立进程：页面里读不到它的 DOM，
 * 离屏渲染下 sendInputEvent 的鼠标事件也进不去（先移动再点也一样）。
 * 所以这里走主进程的 webFrameMain.executeJavaScript 读几何；「点击」改成
 * 对坐标处最上层的元素派发 click，验证真实命中区域没有被遮挡。
 */

const GAP = 1 // 亚像素误差

const frameOf = (t) => t.win.webContents.mainFrame.framesInSubtree.find((f) => f.url === 'about:srcdoc')

/** 在 iframe 里跑一段表达式；iframe 正在换页、句柄失效时返回 undefined */
async function inFrame(t, code) {
  try {
    return await frameOf(t)?.executeJavaScript(code)
  } catch {
    return undefined
  }
}

async function waitFrame(t, expr, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await inFrame(t, `!!(${expr})`)) return true
    await t.sleep(100)
  }
  return false
}

const SNAPSHOT = `(() => {
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom }
  }
  const reachable = (el) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!hit && el.contains(hit)
  }
  const option = (id) => document.querySelector('[data-choice="' + id + '"]')
  const bar = document.getElementById('visual-confirm-bar')
  return {
    feedback: { bar: !!bar, note: !!document.getElementById('visual-note-panel'), button: !!document.getElementById('visual-confirm-btn') },
    innerHeight: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),

    ok: { rect: rectOf(option('ok')), reachable: reachable(option('ok')), selected: !!option('ok')?.classList.contains('selected') },
    change: { rect: rectOf(option('change')), reachable: reachable(option('change')), selected: !!option('change')?.classList.contains('selected') },
    split: rectOf(document.querySelector('.split')),
  }
})()`

async function snapshot(t, scroll) {
  if (scroll === 'bottom') await inFrame(t, 'window.scrollTo(0, document.documentElement.scrollHeight)')
  if (scroll === 'top') await inFrame(t, 'window.scrollTo(0, 0)')
  return inFrame(t, SNAPSHOT)
}

/** 点 iframe 内坐标 (x, y)：对最上层元素派发 click，返回它是谁（选项 id / 元素 id / 标签名） */
function tapAt(t, rect) {
  const x = Math.round(rect.x + rect.w / 2)
  const y = Math.round(rect.y + rect.h / 2)
  return inFrame(
    t,
    `(() => {
      const el = document.elementFromPoint(${x}, ${y})
      if (!el) return null
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))
      const choice = el.closest('[data-choice]')
      if (choice) return choice.dataset.choice
      return el.tagName
    })()`
  )
}

const responds = async (t) => (await t.events()).filter((e) => e.startsWith('respond:'))

export default async function (t) {
  t.ok('面板里有 iframe', await t.waitFor('iframe'))
  t.ok('页面加载完（选项存在）', await waitFrame(t, `document.querySelectorAll('[data-choice]').length === 2`))
  const top = await snapshot(t, 'top')
  await t.shot('top')
  t.check('预览不注入确认条、按钮或补充入口', top.feedback, { bar: false, button: false, note: false })
  t.ok('长页面一屏放不下（场景前提）', top.maxScroll > 100)

  // 滚到底：全部方案仍能完整看见并命中；点方案不会提交评审。
  const bottom = await snapshot(t, 'bottom')
  await t.sleep(400)
  await t.shot('bottom')
  t.check('滚到了底', bottom.scrollY, bottom.maxScroll)
  t.ok('滚到底：B 完整可见', bottom.change.rect.bottom <= bottom.innerHeight + GAP)
  t.ok('滚到底：B 可点击', bottom.change.reachable)
  t.ok('滚到底：A 可点击', bottom.ok.reachable)
  t.check('点之前没有旧通道回传', (await responds(t)).length, 0)
  t.check('点 B 命中选项自身', await tapAt(t, bottom.change.rect), 'change')
  const picked = await snapshot(t)
  t.ok('点 B 只切换显示', picked.change.selected && !picked.ok.selected)
  t.check('点 B 未产生旧通道回传', (await responds(t)).length, 0)
  t.check('点 B 仍无页面确认条', picked.feedback, { bar: false, button: false, note: false })

  // 矮页面仍撑满比较区，但不预留旧确认条高度。
  await t.act('showShort')
  t.ok('换成矮页面', await waitFrame(t, `document.querySelectorAll('.option').length === 2 && document.querySelectorAll('p').length < 20`))
  const short = await snapshot(t, 'top')
  await t.sleep(400)
  await t.shot('short')
  t.ok('矮页面：不需要滚动', short.maxScroll <= GAP)
  t.ok('矮页面：比较区撑满剩余高度', short.split.h > 200)
  t.ok('矮页面：选项 B 仍可点击', short.change.reachable)
  t.check('换页后仍无反馈 UI', short.feedback, { bar: false, button: false, note: false })
  t.check('页面切换也不产生旧通道回传', (await responds(t)).length, 0)
}
