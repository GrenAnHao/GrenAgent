/**
 * 视觉设计面板：底部确认条不能盖住内容。
 * 复现的是「滚到底，选项 B 落在确认条下面，选不了」。
 *
 * 沙箱 iframe（srcdoc、没有 allow-same-origin）是独立进程：页面里读不到它的 DOM，
 * 离屏渲染下 sendInputEvent 的鼠标事件也进不去（先移动再点也一样）。
 * 所以这里走主进程的 webFrameMain.executeJavaScript 读几何；「点击」改成
 * 对坐标处最上层的元素派发 click，效果等同用户点那个位置：被确认条盖住就会点到条上，选不中。
 */

const GAP = 1 // 亚像素误差
const BAR_RESERVE = 64 // frameAssets 给 body 预留的底边距

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
  const barStyle = bar ? getComputedStyle(bar) : null
  const cssNode = document.getElementById('visual-confirm-style')
  const btn = document.getElementById('visual-confirm-btn')
  return {
    innerHeight: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    bar: bar ? { rect: rectOf(bar), flexDirection: barStyle.flexDirection, position: barStyle.position } : null,
    styleDisplay: cssNode ? getComputedStyle(cssNode).display : null,
    ok: { rect: rectOf(option('ok')), reachable: reachable(option('ok')), selected: !!option('ok')?.classList.contains('selected') },
    change: { rect: rectOf(option('change')), reachable: reachable(option('change')), selected: !!option('change')?.classList.contains('selected') },
    split: rectOf(document.querySelector('.split')),
    hint: document.getElementById('visual-confirm-hint')?.textContent ?? null,
    btn: btn ? { rect: rectOf(btn), disabled: btn.disabled, text: btn.textContent } : null,
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
      return el.closest('#visual-confirm-bar') ? 'bar' : el.tagName
    })()`
  )
}

const responds = async (t) => (await t.events()).filter((e) => e.startsWith('respond:'))

export default async function (t) {
  t.ok('面板里有 iframe', await t.waitFor('iframe'))
  t.ok('页面加载完（确认条已注入）', await waitFrame(t, `document.getElementById('visual-confirm-bar')`))

  // —— 刚打开：确认条贴在面板底部，样式节点不画成文字 ——
  const top = await snapshot(t, 'top')
  await t.shot('top')
  t.check('确认条仍是 fixed 贴底', top.bar?.position, 'fixed')
  t.check('确认条是单行横排，不被撑满规则改成竖排', top.bar?.flexDirection, 'row')
  t.check('确认条样式节点保持 display:none（不把 CSS 原文画进页面）', top.styleDisplay, 'none')
  t.ok('页面一屏放不下（场景前提）', top.maxScroll > 100)
  t.checkNear('确认条贴着 iframe 底边', top.bar?.rect.bottom, top.innerHeight, 1)
  t.ok(`确认条高度是一行，不超过预留的 ${BAR_RESERVE}px`, (top.bar?.rect.h ?? 999) <= BAR_RESERVE)

  // —— 滚到底：选项 B 必须完整露在确认条上方，并且点得到 ——
  const bottom = await snapshot(t, 'bottom')
  await t.sleep(400) // 跨进程 iframe 滚动后等合成帧刷新，否则截到的是滚动前的旧帧
  await t.shot('bottom')
  t.check('滚到了底', bottom.scrollY, bottom.maxScroll)
  t.ok(
    `滚到底：选项 B 整个在确认条上方（B.bottom ${Math.round(bottom.change.rect.bottom)} ≤ 条.top ${Math.round(bottom.bar.rect.top)}）`,
    bottom.change.rect.bottom <= bottom.bar.rect.top + GAP
  )
  t.ok('滚到底：选项 B 中心不被确认条遮住（hit test 命中 B）', bottom.change.reachable)
  t.ok('滚到底：选项 A 也没被遮住', bottom.ok.reachable)
  t.ok('确认条在滚动位置上仍可见（贴在底边）', Math.abs(bottom.bar.rect.bottom - bottom.innerHeight) <= GAP)

  // —— 点 B 只选中，再点确认才提交 ——
  t.check('点之前没有任何提交', (await responds(t)).length, 0)
  t.check('点之前确认按钮是禁用的', bottom.btn?.disabled, true)
  t.check('点 B 的位置，最上层是 B 自己', await tapAt(t, bottom.change.rect), 'change')
  const picked = await snapshot(t)
  t.ok('点 B：B 被选中', picked.change.selected)
  t.check('点 B：A 没选中', picked.ok.selected, false)
  t.check('点 B：只选中，还没有提交', (await responds(t)).length, 0)
  t.check('点 B：提示变成「已选：要改」', picked.hint, '已选：要改')
  t.check('点 B：确认按钮可点', picked.btn?.disabled, false)

  t.check('点确认的位置，最上层是确认条', await tapAt(t, picked.btn.rect), 'bar')
  await t.waitUntil(`(window.__uiEvents ?? []).some((e) => e.startsWith('respond:'))`, 3000)
  const sent = await responds(t)
  t.check('点确认：只回传一次', sent.length, 1)
  const answer = JSON.parse(sent[0]?.slice('respond:'.length) || '{}')
  t.check('点确认：回传的是 B', [answer.choice, answer.text], ['change', '要改'])

  // —— 内容比面板矮：比较区仍然撑满中间的剩余空间，选项贴在确认条上方 ——
  await t.act('showShort')
  t.ok('换成矮页面', await waitFrame(t, `document.querySelectorAll('.option').length === 2 && document.getElementById('visual-confirm-bar') && document.querySelectorAll('p').length < 20`))
  const short = await snapshot(t, 'top')
  await t.sleep(400)
  await t.shot('short')
  t.ok('矮页面：不需要滚动', short.maxScroll <= GAP)
  t.checkNear('矮页面：选项贴在确认条预留区上方（比较区撑满了中间）', short.change.rect.bottom, short.innerHeight - BAR_RESERVE, 20)
  t.ok('矮页面：比较区比内容高（吃掉了剩余空间）', short.split.h > 200)
  t.ok('矮页面：选项 B 没被确认条遮住', short.change.rect.bottom <= short.bar.rect.top + GAP && short.change.reachable)
}
