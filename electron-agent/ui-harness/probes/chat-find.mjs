/**
 * 会话内查找（Ctrl+F）：
 * - 焦点在对话底部输入框时 Ctrl+F 也拦截，焦点进查找栏输入框；侧栏那类范围外输入框的 Ctrl+F 不被抢。
 * - 查找栏占独立一行：不压消息、不碰输入区；控件靠右。
 * - 命中计数「当前 / 总数」覆盖没渲染的消息（80 条里 9 处）；逐个 / 循环跳转，当前项不在视口就滚进来。
 * - 高亮走 CSS Custom Highlight，不改 DOM：加粗、行内代码、链接、代码块、复数里的部分匹配都在；当前项另有一层。
 * - 无结果空状态；Enter / Shift+Enter；Esc 关闭、清高亮、焦点回到输入框；新消息到来计数更新；换会话关闭。
 */

const SCROLLER = '[data-testid="chat-scroll"] > div'
const BAR = '[data-testid="chat-find-bar"]'
const INPUT = '[data-testid="find-input"]'
const COUNT = '[data-testid="find-count"]'
const COMPOSER = '[data-testid="composer"]'

const hl = (t, name) => t.js(`(() => { const h = CSS.highlights.get('${name}'); return h ? h.size : 0 })()`)
const activeTestId = (t) => t.js(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName`)
const countText = (t) => t.text(COUNT)

/** 当前项在滚动区里是否完整可见。 */
const currentVisible = `(() => {
  const h = CSS.highlights.get('gren-find-current')
  if (!h) return false
  const r = [...h][0].getBoundingClientRect()
  const s = document.querySelector('${SCROLLER}').getBoundingClientRect()
  return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom
})()`

async function openFromComposer(t) {
  await t.click(COMPOSER, 20)
  await t.key('f', ['control'])
  await t.waitFor(BAR)
}

export default async function (t) {
  const { expected } = await t.data()
  await t.waitFor(SCROLLER)
  await t.sleep(800)

  // —— 打开：焦点在输入框里也拦截 ——
  await t.click(COMPOSER, 20)
  t.check('先把焦点放在底部输入框', await activeTestId(t), 'composer')
  await t.key('f', ['control'])
  t.ok('Ctrl+F：查找栏出现', await t.waitFor(BAR))
  t.check('打开时焦点进查找栏输入框', await activeTestId(t), 'find-input')
  t.check('侧栏那类范围外监听没有收到这次 Ctrl+F', (await t.js('window.__sidebarFind ?? 0')), 0)

  // —— 布局：占独立一行，不压消息、不碰输入区，控件靠右 ——
  const bar = await t.rect(BAR)
  const scroller = await t.rect(SCROLLER)
  const seat = await t.rect('[data-testid="composer-seat"]')
  t.ok(`列表顶边在查找栏下面（栏底 ${Math.round(bar.y + bar.h)}，列表顶 ${Math.round(scroller.y)}）`, scroller.y >= bar.y + bar.h - 1)
  t.ok('查找栏不碰底部输入区', bar.y + bar.h <= seat.y)
  t.checkNear('查找栏高 40px', bar.h, 40, 1)
  t.checkNear('查找栏通栏（宽度同页面）', bar.w, scroller.w, 20)
  const inputBox = await t.rect('[data-testid="find-input"]')
  const closeBox = await t.rect('[data-testid="find-close"]')
  t.ok('输入框在栏的右半边（控件靠右）', inputBox.x > bar.x + bar.w / 2)
  t.ok('关闭按钮贴右、在栏内', closeBox.x + closeBox.w <= bar.x + bar.w && closeBox.x + closeBox.w > bar.x + bar.w - 24)
  t.check('输入为空：不显示计数', await countText(t), '')
  t.check('输入为空：上一个 / 下一个置灰', await t.js(`[document.querySelector('[data-testid="find-prev"]').disabled, document.querySelector('[data-testid="find-next"]').disabled]`), [true, true])

  // —— 输入：计数覆盖没渲染的消息，回到第一个命中 ——
  await t.type('needle')
  t.ok(`计数写成「1 / ${expected}」（80 条消息里大部分没渲染）`, await t.waitUntil(`document.querySelector('${COUNT}').textContent === '1 / ${expected}'`))
  t.ok('当前项是文档里的第一处：滚到了顶部，并且完整可见', await t.waitUntil(currentVisible))
  t.ok('列表确实往上滚了', (await t.js(`document.querySelector('${SCROLLER}').scrollTop`)) < 400)
  t.ok('命中项都有高亮', (await hl(t, 'gren-find')) >= 4)
  t.check('当前项单独一层高亮', await hl(t, 'gren-find-current'), 1)

  // —— 不破坏格式：没有插入 <mark>；加粗、行内代码、链接里的命中也高亮；复数里的部分匹配 ——
  t.check('不改 DOM：没有插入任何 mark', await t.js(`document.querySelectorAll('mark, [data-find-item] [class*="highlight"]').length`), 0)
  const hosts = await t.js(`[...CSS.highlights.get('gren-find')].map((r) => r.startContainer.parentElement.tagName)`)
  t.info('命中所在的元素', hosts)
  t.ok('加粗里的命中', hosts.includes('STRONG') || hosts.includes('B'))
  t.ok('行内代码里的命中', hosts.includes('CODE'))
  t.ok('链接文字里的命中', hosts.includes('A'))
  t.ok('部分匹配：Needles 里只高亮 Needle', await t.js(`[...CSS.highlights.get('gren-find')].some((r) => r.toString().toLowerCase() === 'needle' && r.startContainer.textContent.includes('Needles'))`))
  t.check('加粗 / 链接 / 代码元素原样还在', await t.js(`[!!document.querySelector('${SCROLLER} strong'), !!document.querySelector('${SCROLLER} a[href*="needle-docs"]'), !!document.querySelector('${SCROLLER} code')]`), [true, true, true])
  await t.shot('chat-find-dark')

  // —— 逐个跳转：每一步当前项都完整可见；末尾回到第一个 ——
  for (let n = 2; n <= expected; n += 1) {
    await t.key('Enter')
    const stepped = await t.waitUntil(`document.querySelector('${COUNT}').textContent === '${n} / ${expected}'`)
    if (!stepped) {
      t.info(`第 ${n} 步实际计数`, await countText(t))
      t.info('a20 代码块 DOM', await t.js(`(() => { const el = document.querySelector('[data-find-item="a20"]'); if (!el) return 'a20 未渲染'; const pre = el.querySelector('pre, [class*="code"]'); const hidden = pre ? [pre.checkVisibility({ checkVisibilityCSS: true }), getComputedStyle(pre).contentVisibility, getComputedStyle(pre).visibility, getComputedStyle(pre).display] : null; return { hasPre: !!pre, hidden, html: (pre ?? el).outerHTML.slice(0, 700), text: (pre ?? el).textContent.slice(0, 120) } })()`))
    }
    t.ok(`Enter → ${n} / ${expected}`, stepped)
    t.ok(`第 ${n} 处：滚进可见区域`, await t.waitUntil(currentVisible, 4000))
    if (n === 6) {
      t.ok('第 6 处在代码块里（离屏消息渲染后精确定位）', await t.js(`[...CSS.highlights.get('gren-find-current')][0].startContainer.parentElement.closest('pre') !== null`))
    }
  }
  await t.key('Enter')
  t.ok(`最后一处再按 Enter：循环回到 1 / ${expected}`, await t.waitUntil(`document.querySelector('${COUNT}').textContent === '1 / ${expected}'`))
  t.ok('循环回第一处后它可见', await t.waitUntil(currentVisible, 4000))
  await t.key('Enter', ['shift'])
  t.ok(`第一处按 Shift+Enter：循环到 ${expected} / ${expected}`, await t.waitUntil(`document.querySelector('${COUNT}').textContent === '${expected} / ${expected}'`))
  t.ok('最后一处（列表底部）可见', await t.waitUntil(currentVisible, 4000))
  await t.key('Enter', ['shift'])
  t.ok(`Shift+Enter 往前一个：${expected - 1} / ${expected}`, await t.waitUntil(`document.querySelector('${COUNT}').textContent === '${expected - 1} / ${expected}'`))

  // 按钮同样可用
  await t.click('[data-testid="find-next"]', 8)
  t.ok('点「下一个」按钮', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '${expected} / ${expected}'`))
  await t.click('[data-testid="find-prev"]', 8)
  t.ok('点「上一个」按钮', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '${expected - 1} / ${expected}'`))

  // —— 再按 Ctrl+F：仍在输入框里全选，不重置查询 ——
  await t.key('f', ['control'])
  t.check('已经打开时再按 Ctrl+F：查询不变', await t.js(`document.querySelector('${INPUT}').value`), 'needle')
  t.check('已经打开时再按 Ctrl+F：输入框全选', await t.js(`(() => { const i = document.querySelector('${INPUT}'); return [i.selectionStart, i.selectionEnd] })()`), [0, 6])

  // —— 输入变化：实时重算并回到第一个 ——
  await t.key('End') // 上一步是全选，先取消选中再追加一个字符
  await t.type('x')
  t.ok('输入变化：重算，改成 needlex 之后无结果', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '无结果'`))
  await t.key('Backspace')
  t.ok('删掉一个字：回到 1 / 9', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '1 / ${expected}'`))

  // —— 无结果空状态 ——
  await t.key('a', ['control'])
  await t.type('zzzq')
  t.ok('无结果：明确写「无结果」', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '无结果'`))
  t.check('无结果：上一个 / 下一个置灰', await t.js(`[document.querySelector('[data-testid="find-prev"]').disabled, document.querySelector('[data-testid="find-next"]').disabled]`), [true, true])
  t.check('无结果：输入框标红', await t.js(`document.querySelector('${INPUT}').parentElement.getAttribute('data-empty-result')`), 'true')
  t.check('无结果：没有高亮', [await hl(t, 'gren-find'), await hl(t, 'gren-find-current')], [0, 0])
  await t.shot('chat-find-empty')
  await t.key('Enter')
  t.check('无结果时 Enter 不动', await countText(t), '无结果')
  await t.key('a', ['control'])
  await t.key('Backspace')
  t.ok('清空输入：计数消失、回到初始状态', await t.waitUntil(`document.querySelector('${COUNT}').textContent === ''`))

  // —— 流式 / 新消息：计数更新，当前项保持 ——
  await t.type('needle')
  t.ok('重新输入得到 1 / 9', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '1 / ${expected}'`))
  await t.act('appendAssistant', '新来的消息里有 needle 和 needle 两处')
  t.ok('新消息到来：总数 +2，当前项还是第 1 处', await t.waitUntil(`document.querySelector('${COUNT}').textContent === '1 / ${expected + 2}'`))

  // —— Esc：关闭、清高亮、焦点回到打开前的输入框 ——
  await t.key('Escape')
  t.ok('Esc：查找栏消失', await t.waitUntil(`!document.querySelector('${BAR}')`))
  t.check('Esc：高亮清掉', [await hl(t, 'gren-find'), await hl(t, 'gren-find-current')], [0, 0])
  t.ok('Esc：焦点回到打开前的底部输入框', await t.waitUntil(`document.activeElement?.getAttribute('data-testid') === 'composer'`))
  t.ok('关闭后列表顶边回到顶部（不再留空行）', (await t.rect(SCROLLER)).y < 10)

  // —— 焦点在范围之外：不拦，侧栏原有的 Ctrl+F 照旧 ——
  await t.click('[data-testid="outside-input"]', 10)
  t.check('先把焦点放到范围之外的输入框', await activeTestId(t), 'outside-input')
  await t.key('f', ['control'])
  await t.sleep(200)
  t.check('范围之外：查找栏不出现', await t.count(BAR), 0)
  t.check('范围之外：原有监听收到了 Ctrl+F', await t.js('window.__sidebarFind ?? 0'), 1)

  // —— 点了消息文字（焦点落在 body）：按最后一次点击所在的范围认领 ——
  const point = await t.rect(`${SCROLLER} [data-find-item]`)
  await t.click({ x: Math.round(point.x + point.w / 2), y: Math.round(point.y + 8) })
  await t.key('f', ['control'])
  t.ok('点了消息区之后 Ctrl+F：打开会话查找', await t.waitFor(BAR))
  t.check('范围内：原有监听没有再收到', await t.js('window.__sidebarFind ?? 0'), 1)

  // —— 换会话：查找栏关闭（结果属于上一个会话）——
  await t.type('needle')
  await t.waitUntil(`document.querySelector('${COUNT}').textContent.endsWith('/ ${expected}')`)
  await t.act('switchSession', 'session-b')
  t.ok('换会话：查找栏关闭', await t.waitUntil(`!document.querySelector('${BAR}')`))
  t.check('换会话：高亮清掉', await hl(t, 'gren-find'), 0)

  // —— 浅色主题 ——
  await openFromComposer(t)
  await t.type('needle')
  await t.waitUntil(`document.querySelector('${COUNT}').textContent === '1 / ${expected}'`)
  await t.key('Enter')
  await t.setTheme('light')
  await t.sleep(300)
  t.ok('浅色：查找栏浅底', await t.waitUntil(`(() => { const c = getComputedStyle(document.querySelector('${BAR}')).backgroundColor; return c === 'rgb(255, 255, 255)' || /^rgb\\(2[0-9][0-9]/.test(c) })()`))
  const colors = await t.js(`(() => {
    const el = [...CSS.highlights.get('gren-find-current')][0].startContainer.parentElement
    const cur = getComputedStyle(el, '::highlight(gren-find-current)')
    const hit = getComputedStyle(el, '::highlight(gren-find)')
    return { current: cur.backgroundColor, currentText: cur.color, hit: hit.backgroundColor }
  })()`)
  t.info('浅色：高亮计算色', colors)
  await t.shot('chat-find-light')
  await t.setTheme('dark')
}
