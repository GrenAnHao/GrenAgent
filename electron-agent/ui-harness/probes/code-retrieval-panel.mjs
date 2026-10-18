/**
 * Agent 数据 · 代码索引：项目有 3000 个文件，源码有 12000 行的大文件。
 * - 文件列表由主进程按页返回：每次请求只要一页，结果行只画已加载的页，尾部「显示更多」点一次取一页，一路点到底也不退回前端切页。
 * - 页面高度有上限：外层面板（AgentDataCenter 的 panel）不被撑长、不出现整页滚动，结果列表在左栏里自己滚。
 * - 原始结果展开前不画内容，展开后高度有上限，超长的内容被截断并写明。
 * - 换成搜索后页数重置；点结果进详情，详情栏同样在栏内滚动，窄视口（只显示详情栏）也一样。
 * - 大文件的源码预览虚拟化：DOM 里只有窗口附近的行，目标行居中、跳到任意行、滚到头尾都对，折行的长注释行高不一也不乱。
 */

const PANEL = '[data-testid="agent-data-panel"]'
const SPLIT = '[data-split-side]'
const MAIN = '[data-split-main]'
const ROWS = '[data-code-list] [aria-pressed]'
const INPUT = 'input[aria-label="搜索代码"]'
const JUMP_INPUT = 'input[aria-label="行号"]'
const SRC = 'pre[aria-label="源码内容"]'
const SRC_LINES = `${SRC} [data-source-line]`
/** 窗口里的行数上限：预览 520px 高、每行约 20px，加上缓冲也远小于这个数 */
const WINDOW_LIMIT = 300

/** 滚动容器自身有没有溢出：scrollHeight 比 clientHeight 大就是在栏内滚动 */
const metrics = (sel) => `(() => {
  const el = document.querySelector('${sel}')
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }
})()`

/** 按文字找到元素并打上标记，再用真实鼠标点 */
async function markByText(t, selector, text, mark) {
  return t.js(`(() => {
    document.querySelectorAll('[data-probe-node="${mark}"]').forEach((n) => n.removeAttribute('data-probe-node'))
    const el = [...document.querySelectorAll('${selector}')].find((n) => n.textContent.trim().startsWith('${text}'))
    if (!el) return false
    el.setAttribute('data-probe-node', '${mark}')
    return true
  })()`)
}

/** column：当前显示的那一栏（窄视口只显示详情栏，左栏 display:none，量它的 bottom 是 0） */
async function expectBoundedPage(t, label, column = SPLIT) {
  const panel = await t.js(metrics(PANEL))
  const viewport = await t.js('window.innerHeight')
  t.ok(`${label}：外层面板没有被撑长（不出现整页滚动）`, panel.scrollHeight <= panel.clientHeight + 1)
  const shown = await t.js(metrics(column))
  t.ok(`${label}：分栏有高度，底边在窗口里（${Math.round(shown.bottom)} ≤ ${viewport}）`, shown.clientHeight > 200 && shown.bottom <= viewport)
}

/** 滚到栏底，等到真的到底 */
async function scrollToEnd(t, sel) {
  await t.wheel(sel, 20000000)
  await t.waitUntil(`(() => { const e = document.querySelector('${sel}'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2 })()`)
}

/** 元素是否完整在容器可视区里 */
const insideScroller = (lineSel, scrollerSel) => `(() => {
  const line = document.querySelector('${lineSel}')
  const box = document.querySelector('${scrollerSel}')
  if (!line || !box) return false
  const a = line.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  return a.top >= b.top - 1 && a.bottom <= b.bottom + 1
})()`

/** 行中心离预览中心多远（像素） */
const offCenter = (lineSel) => `(() => {
  const a = document.querySelector('${lineSel}').getBoundingClientRect()
  const b = document.querySelector('${SRC}').getBoundingClientRect()
  return Math.round(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)))
})()`

export default async function (t) {
  const data = await t.data()

  // —— 空查询：浏览整个项目的文件，主进程按页返回 ——
  t.ok('文件列表渲染出来', await t.waitFor(ROWS))
  await t.waitUntil(`document.querySelectorAll('${ROWS}').length === ${data.pageSize}`)
  t.check('3000 个文件只画第一页', await t.count(ROWS), data.pageSize)
  t.check('只向主进程要了第一页', await t.events(), [`files:0+${data.pageSize}`])
  t.ok('顶部写着真实总数（不是已加载的行数）', (await t.text('[data-code-list]')).includes(`${data.fileCount} 个结果`))
  await expectBoundedPage(t, '空查询')
  const side = await t.js(metrics(SPLIT))
  t.ok('结果比栏高，列表在栏内滚动', side.scrollHeight > side.clientHeight + 100)
  t.ok('分栏吃掉了页头以下的剩余高度', side.clientHeight > 440)
  await t.shot('files-first-page')

  // 滚到栏底，「显示更多」就在眼前，点得到
  await scrollToEnd(t, SPLIT)
  t.ok('找到「显示更多」', await markByText(t, '[data-code-list] button', '显示更多', 'more'))
  const more = await t.rect('[data-probe-node="more"]')
  const box = await t.rect(SPLIT)
  t.ok('滚到底后「显示更多」完整露在栏里', more.y >= box.y && more.bottom <= box.bottom + 1)
  t.ok('按钮写着剩余数量', (await t.text('[data-probe-node="more"]')).includes(`还有 ${data.fileCount - data.pageSize} 项`))
  await t.click('[data-probe-node="more"]', 40)
  await t.waitUntil(`document.querySelectorAll('${ROWS}').length === ${data.pageSize * 2}`)
  t.check('点一次追加一页', await t.count(ROWS), data.pageSize * 2)
  t.check('第二页从第 100 项起，只要了一页', await t.events(), [`files:0+${data.pageSize}`, `files:${data.pageSize}+${data.pageSize}`])
  await expectBoundedPage(t, '追加一页后')

  // 一路点到底：最后一页到了，行不退回前端切页，按钮消失
  for (let i = 0; i < data.fileCount / data.pageSize; i++) {
    await scrollToEnd(t, SPLIT)
    if (!(await markByText(t, '[data-code-list] button', '显示更多', 'more'))) break
    const before = await t.count(ROWS)
    await t.click('[data-probe-node="more"]', 40)
    await t.waitUntil(`document.querySelectorAll('${ROWS}').length > ${before}`)
  }
  t.check('一路点到底，3000 个文件全部加载', await t.count(ROWS), data.fileCount)
  t.ok('全部加载后「显示更多」消失', !(await markByText(t, '[data-code-list] button', '显示更多', 'gone')))
  const events = await t.events()
  t.check('一共 30 次请求，每次一页', events.length, data.fileCount / data.pageSize)
  t.ok('没有任何一次请求返回超过一页', events.every((event) => event.endsWith(`+${data.pageSize}`)))
  t.ok('顶部仍写着总数', (await t.text('[data-code-list]')).includes(`${data.fileCount} 个结果`))
  await expectBoundedPage(t, '全部加载后')
  t.check('折叠着的原始结果不画内容', await t.count('[data-code-list] details pre'), 0)
  await t.shot('files-all-loaded')

  // —— 换成搜索：页数重置，只有 40 条，没有「显示更多」 ——
  await t.click(INPUT, 20)
  await t.type('parse')
  await t.waitUntil(`document.querySelectorAll('${ROWS}').length === ${data.symbolCount}`)
  t.check('搜索结果 40 条全画出来', await t.count(ROWS), data.symbolCount)
  t.ok('不足一页没有「显示更多」', !(await markByText(t, '[data-code-list] button', '显示更多', 'none')))
  await expectBoundedPage(t, '搜索结果')

  // 原始结果：展开后高度有上限，响应里的大块 extra 被截断
  await scrollToEnd(t, SPLIT)
  t.ok('找到「原始结果」', await markByText(t, '[data-code-list] summary', '原始结果', 'raw'))
  t.check('折叠时不画原始内容', await t.count('[data-code-list] details pre'), 0)
  await t.click('[data-probe-node="raw"]', 20)
  t.ok('展开后出现原始内容', await t.waitFor('[data-code-list] details pre'))
  const pre = await t.rect('[data-code-list] details pre')
  t.ok(`原始内容高度有上限（${Math.round(pre.h)}px ≤ 422px）`, pre.h <= 422)
  t.ok('超长内容写明已截断', (await t.text('[data-code-list]')).includes('已截断'))
  await expectBoundedPage(t, '展开原始结果后')

  // —— 详情一：400 行的小文件整块渲染 ——
  await t.js(`document.querySelector('${SPLIT}').scrollTop = 0`)
  await t.click(ROWS, 20)
  t.ok('源码预览出来', await t.waitFor(SRC))
  await t.waitUntil(`document.querySelectorAll('${SRC} > div').length === ${data.smallSourceLines}`)
  t.check('小文件 400 行全在 DOM 里（不虚拟化，整段可选中复制）', await t.count(`${SRC} > [data-source-line]`), data.smallSourceLines)
  const mainBox = await t.js(metrics(MAIN))
  const sideBox = await t.js(metrics(SPLIT))
  t.check('详情栏和列表栏同高', mainBox.clientHeight, sideBox.clientHeight)
  t.ok('详情内容比栏高，在栏内滚动', mainBox.scrollHeight > mainBox.clientHeight)
  const source = await t.rect(SRC)
  t.ok(`源码预览自己有高度上限（${Math.round(source.h)}px ≤ 522px）`, source.h <= 522)
  await expectBoundedPage(t, '详情')
  await t.shot('detail')

  // —— 详情二：12000 行的大文件，虚拟化 ——
  await t.js(`(() => {
    const row = document.querySelectorAll('${ROWS}')[1]
    row.setAttribute('data-probe-node', 'row2')
    row.scrollIntoView({ block: 'center' })
  })()`)
  await t.click('[data-probe-node="row2"]', 20)
  await t.waitUntil(`document.body.textContent.includes('${data.bigSourceLines} 行 · 只读')`)
  await t.waitUntil(`!!document.querySelector('${SRC}') && document.querySelectorAll('${SRC_LINES}').length > 0`)
  const windowed = await t.count(SRC_LINES)
  t.ok(`大文件只挂窗口附近的行（${windowed} 行，不是 ${data.bigSourceLines}）`, windowed > 0 && windowed < WINDOW_LIMIT)
  t.ok('索引行 6 挂在 DOM 里且标成当前位置', (await t.js(`document.querySelector('[data-testid="code-source-line-6"]')?.getAttribute('aria-current')`)) === 'location')
  t.ok('索引行 6 完整在预览可视区里', await t.waitUntil(insideScroller('[data-testid="code-source-line-6"]', SRC)))
  const bigSource = await t.rect(SRC)
  t.ok(`大文件预览同样有高度上限（${Math.round(bigSource.h)}px ≤ 522px）`, bigSource.h <= 522)
  await expectBoundedPage(t, '大文件详情')

  // 跳到第 9000 行：目标行不在 DOM 里，靠 scrollToIndex 滚过去并居中
  await t.click(JUMP_INPUT, 20)
  await t.type('9000')
  await t.key('Return')
  await t.waitUntil(`document.querySelector('[data-testid="code-source-line-9000"]')?.getAttribute('aria-current') === 'location'`)
  t.ok('跳到第 9000 行后它在预览可视区里', await t.waitUntil(insideScroller('[data-testid="code-source-line-9000"]', SRC)))
  const off = await t.js(offCenter('[data-testid="code-source-line-9000"]'))
  t.ok(`第 9000 行大致居中（偏离 ${off}px ≤ 120px）`, off <= 120)
  t.ok('跳转后窗口仍然很小', (await t.count(SRC_LINES)) < WINDOW_LIMIT)
  await t.shot('big-source-line-9000')

  // 折行的长注释行：第 200 行比普通行高，窗口里的行高不一也不叠在一起
  await t.click(JUMP_INPUT, 20)
  await t.key('a', ['control'])
  await t.type(String(data.longCommentEvery))
  await t.key('Return')
  await t.waitUntil(`document.querySelector('[data-testid="code-source-line-${data.longCommentEvery}"]')?.getAttribute('aria-current') === 'location'`)
  await t.waitUntil(insideScroller(`[data-testid="code-source-line-${data.longCommentEvery}"]`, SRC))
  const wrapped = await t.rect(`[data-testid="code-source-line-${data.longCommentEvery}"]`)
  const plain = await t.rect(`[data-testid="code-source-line-${data.longCommentEvery - 1}"]`)
  t.ok(`折行的长注释比普通行高（${Math.round(wrapped.h)}px > ${Math.round(plain.h)}px）`, wrapped.h > plain.h * 1.5)
  t.ok('长注释行紧接着上一行，没有重叠', Math.abs(plain.bottom - wrapped.y) <= 1)

  // 滚到文件尾、再滚回文件头：两头的行都挂得出来，滚动中窗口始终很小
  for (let i = 0; i < 8 && !(await t.js(`!!document.querySelector('[data-testid="code-source-line-${data.bigSourceLines}"]')`)); i++) {
    await t.wheel(SRC, 20000000)
  }
  t.ok('滚到底能看到最后一行', await t.waitFor(`[data-testid="code-source-line-${data.bigSourceLines}"]`))
  t.ok('滚到底时窗口仍然很小', (await t.count(SRC_LINES)) < WINDOW_LIMIT)
  for (let i = 0; i < 8 && !(await t.js(`!!document.querySelector('[data-testid="code-source-line-1"]')`)); i++) {
    await t.wheel(SRC, -20000000)
  }
  t.ok('滚回顶部能看到第一行', await t.waitFor('[data-testid="code-source-line-1"]'))

  // —— 矮窗口：卡片有 320px 的下限，放不下的部分由外层面板滚动，不是把分栏压成一条缝 ——
  // 卡片里还有搜索栏（约 47px），所以分栏至少 270px 左右；下限没生效时这里只有 150px 上下。
  const tall = await t.resize(1420, 300)
  const shortSide = await t.js(metrics(SPLIT))
  const shortPanel = await t.js(metrics(PANEL))
  t.ok(`矮窗口：分栏保住了下限（${shortSide.clientHeight}px ≥ 260px）`, shortSide.clientHeight >= 260)
  t.ok('矮窗口：放不下的部分由外层面板滚动', shortPanel.scrollHeight > shortPanel.clientHeight + 20)
  await t.resize(...tall)

  // —— 窄视口：容器小于 800px 只显示详情栏，同样有上限 ——
  const restore = await t.resize(640, 880)
  await expectBoundedPage(t, '窄视口详情', MAIN)
  const narrow = await t.js(metrics(MAIN))
  t.ok('窄视口详情栏在栏内滚动', narrow.scrollHeight > narrow.clientHeight)
  t.ok('窄视口下大文件窗口仍然很小', (await t.count(SRC_LINES)) < WINDOW_LIMIT)
  await t.shot('detail-narrow')
  await t.resize(...restore)
}
