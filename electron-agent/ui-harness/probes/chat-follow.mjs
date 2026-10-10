const list = '[data-testid="chat-scroll"]'
const scroller = `${list} > div`

/** 滚动区底部还差多少像素，以及当前 scrollTop。 */
async function pos(t) {
  return t.js(`(() => {
    const h = document.querySelector('${scroller}')
    return { top: h.scrollTop, fromBottom: h.scrollHeight - h.scrollTop - h.clientHeight, canScroll: h.scrollHeight > h.clientHeight }
  })()`)
}

/** 分几次增长，模拟流式；每次之间留出几帧让测高和贴底跑完。 */
async function stream(t, times, lines) {
  for (let i = 0; i < times; i++) {
    await t.act('grow', lines)
    await t.sleep(120)
  }
  await t.sleep(300)
}

async function load(t, kind) {
  await t.act('load', kind)
  await t.sleep(600)
}

/** 滚动区内靠上的一个点：落在普通文字上，而不是内部滚动区上。 */
async function topPoint(t) {
  const r = await t.rect(scroller)
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + 60) }
}

export default async function (t) {
  await t.waitFor(scroller)
  await t.sleep(600)

  // 基线：打开就在底部，流式增长一路跟着。
  t.ok('长会话：打开即贴底', (await pos(t)).fromBottom < 4)
  await stream(t, 6, 3)
  t.ok('长会话：流式增长持续贴底', (await pos(t)).fromBottom < 4)

  // 在内部滚动区上滚轮：内部区自己滚，外层列表没动，不能因此停止贴底。
  await t.js(`document.querySelector('[data-testid="inner-scroll"]').scrollIntoView({ block: 'nearest' })`)
  await t.sleep(300)
  await t.wheel('[data-testid="inner-scroll"]', 300)
  await t.wheel('[data-testid="inner-scroll"]', -120)
  const innerTop = await t.js(`document.querySelector('[data-testid="inner-scroll"]').scrollTop`)
  t.ok(`内部滚动区：滚轮由内部区接走（内部 scrollTop ${Math.round(innerTop)}）`, innerTop > 0)
  await stream(t, 6, 4)
  const afterInner = await pos(t)
  t.ok(`内部滚动区上滚后：外层列表仍然贴底（离底 ${Math.round(afterInner.fromBottom)}px）`, afterInner.fromBottom < 4)

  // 会话还不满一屏时随手往上滚：外层滚不动，之后内容长过一屏也要贴底。
  await load(t, 'short')
  t.ok('短会话：内容不满一屏', !(await pos(t)).canScroll)
  await t.wheel(await topPoint(t), -300)
  await stream(t, 8, 10)
  const afterShort = await pos(t)
  t.ok(`短会话上滚后内容长过一屏：仍然贴底（离底 ${Math.round(afterShort.fromBottom)}px）`, afterShort.canScroll && afterShort.fromBottom < 4)

  // 快速输出：每帧都长高、不时插入新条目，一下挤过一屏也要一直贴底。
  await load(t, 'long')
  await t.act('burst', 2500, 8, 6)
  await t.sleep(600)
  const afterBurst = await pos(t)
  t.ok(`快速输出（每 8ms 长 6 行）：仍然贴底（离底 ${Math.round(afterBurst.fromBottom)}px）`, afterBurst.fromBottom < 4)
  await load(t, 'long')
  await t.act('burst', 2500, 16, 20, 5)
  await t.sleep(600)
  const afterBurst2 = await pos(t)
  t.ok(`快速输出夹着新条目：仍然贴底（离底 ${Math.round(afterBurst2.fromBottom)}px）`, afterBurst2.fromBottom < 4)

  // 一次追加一大段（远超贴底阈值）：贴底不能因为测高赶在滚动事件前面而丢掉。
  await load(t, 'long')
  for (let i = 0; i < 4; i++) {
    await t.act('append', 90)
    await t.sleep(30)
    await t.act('grow', 40)
    await t.sleep(200)
  }
  await t.sleep(300)
  const afterAppend = await pos(t)
  t.ok(`大段追加：仍然贴底（离底 ${Math.round(afterAppend.fromBottom)}px）`, afterAppend.fromBottom < 4)

  // 用户真的把列表往上滚：停止贴底，新内容不再把视图拽回去，露出「回到底部」。
  await t.wheel(await topPoint(t), -800)
  await t.sleep(300)
  const left = await pos(t)
  t.ok(`真实上滚：离开底部（离底 ${Math.round(left.fromBottom)}px）`, left.fromBottom > 200)
  await stream(t, 5, 4)
  const reading = await pos(t)
  t.checkNear('真实上滚后流式增长：阅读位置不动', reading.top, left.top, 2)
  t.check('真实上滚：露出「回到底部」', await t.countVisible('[data-testid="jump-to-bottom"]'), 1)

  // 发出新消息：不管停在哪里都回到底部继续跟随。
  await t.act('send')
  await t.sleep(400)
  t.ok('发出新消息：回到底部', (await pos(t)).fromBottom < 4)
  await stream(t, 4, 4)
  t.ok('发出新消息后：流式增长继续贴底', (await pos(t)).fromBottom < 4)

  // 流式中小幅上滚（远小于旧的 120px 阈值）：停手后不被拽回底部。
  await t.wheel(await topPoint(t), -80)
  await t.sleep(300)
  await stream(t, 5, 4)
  const nudged = await pos(t)
  t.ok(`小幅上滚：流式增长不把视图拽回底部（离底 ${Math.round(nudged.fromBottom)}px）`, nudged.fromBottom > 40)
  await t.click('[data-testid="jump-to-bottom"]', 16)
  await t.sleep(400)
  t.ok('点「回到底部」：回到底部', (await pos(t)).fromBottom < 4)

  // 键盘翻页同样是读者移动（不靠滚轮识别）。
  await t.click(await topPoint(t))
  await t.key('PageUp')
  await t.sleep(400)
  await stream(t, 4, 4)
  const paged = await pos(t)
  t.ok(`键盘 PageUp：离开底部且不被拽回（离底 ${Math.round(paged.fromBottom)}px）`, paged.fromBottom > 200)

  // 滚回底部：恢复贴底。
  await t.wheel(await topPoint(t), 40000)
  await t.sleep(300)
  await stream(t, 5, 4)
  t.ok('滚回底部：恢复贴底', (await pos(t)).fromBottom < 4)
  t.check('滚回底部：「回到底部」隐藏', await t.countVisible('[data-testid="jump-to-bottom"]'), 0)

  // 真实对话组件：Markdown、代码高亮、表格、工具卡都会在提交之后自己再长高。
  await t.act('loadReal')
  await t.sleep(1500)
  t.ok('真实对话：打开即贴底', (await pos(t)).fromBottom < 4)
  // 抖动：跟随中视图被往上推离底部、下一帧再拉回。document 的 capture 阶段先于列表自己的 scroll 处理，
  // 读到的就是上一帧画出来的位置；往上走且不在底部的帧就是抖的那一下。往下走的是正常的跟随滞后。
  await t.js(`(() => {
    const h = document.querySelector('${scroller}')
    window.__shake = []
    window.__lastTop = h.scrollTop
    document.addEventListener('scroll', (e) => {
      if (e.target !== h) return
      const top = h.scrollTop
      const fromBottom = h.scrollHeight - top - h.clientHeight
      if (top < window.__lastTop - 0.5 && fromBottom > 2) window.__shake.push([Math.round(top - window.__lastTop), Math.round(fromBottom)])
      window.__lastTop = top
    }, true)
  })()`)
  for (const [every, toolEvery] of [[100, 6], [30, 4], [10, 3]]) {
    await t.js(`window.__shake = []`)
    await t.act('streamReal', 3000, every, toolEvery)
    await t.sleep(1500)
    const real = await pos(t)
    t.ok(`真实对话快速输出（每 ${every}ms 一段，每 ${toolEvery} 段一张工具卡）：仍然贴底（离底 ${Math.round(real.fromBottom)}px）`, real.fromBottom < 4)
    const shake = await t.js(`window.__shake`)
    t.check(`真实对话快速输出（每 ${every}ms）：没有被往上推离底部的帧 ${JSON.stringify(shake.slice(0, 6))}`, shake.length, 0)
  }

  // 快速输出中读者往上滚：照样离开底部，输出继续也不把视图拽回去。
  // 不 await：executeJavaScript 会等 Promise 结束，那样上滚就落在输出结束之后了。
  await t.js(`void (window.__realDone = window.__uiActions.streamReal(4000, 30, 4)); 0`)
  await t.sleep(800)
  await t.wheel(await topPoint(t), -900)
  await t.sleep(400)
  const leftReal = await pos(t)
  await t.js(`window.__realDone`)
  await t.sleep(800)
  const afterReal = await pos(t)
  t.ok(`真实对话快速输出中上滚：离开底部（离底 ${Math.round(leftReal.fromBottom)}px）`, leftReal.fromBottom > 300)
  t.ok(`真实对话快速输出中上滚：输出结束后仍停在读者位置（scrollTop ${Math.round(leftReal.top)} → ${Math.round(afterReal.top)}）`, Math.abs(afterReal.top - leftReal.top) < 40 && afterReal.fromBottom > 300)
  t.check('真实对话快速输出中上滚：露出「回到底部」', await t.countVisible('[data-testid="jump-to-bottom"]'), 1)
}
