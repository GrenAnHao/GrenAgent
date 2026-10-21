/**
 * 会话归档：菜单「归档」、运行中置灰、归档后行消失且底部计数变化、对话整目录归档、
 * 「已归档」弹窗（按时间倒序、查看只读、取消归档后回到侧栏、删除要二次确认）、浅色主题。
 */

const ROWS = '[data-testid="sidebar"] .pi-session-row'
const MENU_OPEN = `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`
const MODAL = '.archived-modal .ant-modal'
const VIEWER = '.archived-viewer .ant-modal'
const CONFIRM = '.archived-delete .ant-modal'
const ARCHIVE_BTN = '[data-testid="sidebar"] [data-testid="session-archive-button"]'

/** 侧栏里标题包含 title 的会话行，返回行内偏左的一点；不在就是 null。 */
const rowPoint = (t, title) =>
  t.js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(ROWS)})].find((r) => r.textContent.includes(${JSON.stringify(title)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + 40, y: r.y + r.height / 2 }
  })()`)

const rowTitles = (t) => t.js(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].map((r) => r.textContent.trim())`)

/** 可见菜单里文字为 label 的菜单项（antd 关掉的菜单还留在 DOM 里）。 */
const menuItem = (label) =>
  `(() => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${JSON.stringify(label)} && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })))()`

async function clickMenuItem(t, label) {
  const p = await t.js(`(() => { const el = ${menuItem(label)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 } })()`)
  if (!p) return null
  return t.click(p)
}

async function closeMenu(t) {
  await t.key('Escape')
  await t.waitUntil(`!(${MENU_OPEN})`)
}

/** 弹窗里 data-path 对应那一行的按钮 */
const rowButton = (path, testId) => `.archived-modal [data-testid="archived-row"][data-path="${path}"] [data-testid="${testId}"]`

export default async function (t) {
  const { paths } = await t.data()
  t.ok('侧栏渲染出来', await t.waitFor(ROWS))
  await t.mouse(2, 2)

  const before = await rowTitles(t)
  t.ok('初始：已归档的「旧的发布脚本」不在侧栏', !before.some((s) => s.includes('旧的发布脚本')))
  t.ok('初始：对话只显示最新的「写周报」', before.some((s) => s.includes('写周报')) && !before.some((s) => s.includes('上周的周报草稿')))
  t.check('初始：底部「已归档」计数 1', await t.text('[data-testid="archived-count"]'), '1')
  await t.shot('initial')

  // —— 运行中的会话：归档置灰，点了也不调主进程 ——
  await t.rightClick(await rowPoint(t, '修复登录页'))
  t.ok('运行中：菜单弹出', await t.waitUntil(MENU_OPEN))
  t.ok('运行中：「归档」置灰', await t.js(`${menuItem('归档（运行中不可用）')}?.getAttribute('aria-disabled') === 'true'`))
  await clickMenuItem(t, '归档（运行中不可用）')
  t.check('运行中：没有发归档请求', (await t.events()).filter((e) => e.startsWith('archive:')).length, 0)
  if (await t.js(MENU_OPEN)) await closeMenu(t)

  // —— 归档项目里的一份会话 ——
  await t.rightClick(await rowPoint(t, '重构订单查询'))
  t.ok('空闲：菜单弹出', await t.waitUntil(MENU_OPEN))
  t.ok('空闲：「归档」可点', await t.js(`${menuItem('归档')}?.getAttribute('aria-disabled') !== 'true'`))
  await clickMenuItem(t, '归档')
  t.ok('归档：行从侧栏消失', await t.waitUntil(`![...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.includes('重构订单查询'))`))
  t.ok('归档：主进程收到这一份路径', (await t.events()).includes(`archive:${paths.REFACTOR}`))
  t.check('归档：计数变成 2', await t.text('[data-testid="archived-count"]'), '2')
  t.ok('归档：没有弹删除确认', (await t.countVisible('.ant-modal')) === 0)

  // —— 运行中的行悬停：没有归档按钮 ——
  await t.hover(await rowPoint(t, '修复登录页'))
  t.check('运行中悬停：没有归档按钮', await t.countVisible(ARCHIVE_BTN), 0)
  await t.mouse(2, 2)

  // —— 归档对话：用「更多」左边的按钮，点了立刻归档；目录下的两份一起归档，次新的不会顶上来 ——
  t.check('静止：归档按钮不可见', await t.countVisible(ARCHIVE_BTN), 0)
  await t.hover(await rowPoint(t, '写周报'))
  t.check('悬停：只有这一行出现归档按钮', await t.countVisible(ARCHIVE_BTN), 1)
  const geo = await t.js(`(() => {
    const btn = [...document.querySelectorAll(${JSON.stringify(ARCHIVE_BTN)})].find((el) => el.checkVisibility())
    const row = btn.closest('.pi-session-row')
    const more = row.querySelector('[data-running] [role="button"]')
    const a = btn.getBoundingClientRect(), m = more.getBoundingClientRect()
    return { gap: m.left - a.right, dy: Math.abs((a.top + a.height / 2) - (m.top + m.height / 2)), w: a.width, mw: m.width }
  })()`)
  t.ok(`悬停：归档按钮紧挨在「更多」左边（间距 ${geo.gap}px）`, geo.gap >= 0 && geo.gap <= 4)
  t.checkNear('悬停：和「更多」同一行居中', geo.dy, 0, 1)
  t.checkNear('悬停：和「更多」同宽', geo.w, geo.mw, 0.5)
  t.ok('悬停：点得到归档按钮', await t.hitTest(`${ARCHIVE_BTN}`))
  await t.shot('hover-archive-button')
  const opensBefore = (await t.events()).filter((e) => e.startsWith('open:')).length
  await t.click(ARCHIVE_BTN, 12)
  t.check('按钮：没有弹确认', await t.countVisible('.ant-modal'), 0)
  t.check('按钮：没有触发整行点击', (await t.events()).filter((e) => e.startsWith('open:')).length, opensBefore)
  t.ok('对话：行消失', await t.waitUntil(`![...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.includes('周报'))`))
  const convEvent = (await t.events()).find((e) => e.startsWith('archive:') && e.includes(paths.WEEKLY))
  t.check('对话：两份会话一起归档', convEvent?.split(':').slice(1).join(':').split(',').sort(), [paths.WEEKLY, paths.WEEKLY_OLD].sort())
  t.check('对话：计数变成 4', await t.text('[data-testid="archived-count"]'), '4')
  t.ok('运行中的会话还在侧栏', (await rowTitles(t)).some((s) => s.includes('修复登录页')))
  await t.shot('after-archive')

  // —— 已归档弹窗 ——
  await t.click('[data-testid="archived-entry"]', 20)
  t.ok('弹窗：打开', await t.waitUntil(`document.querySelector(${JSON.stringify(MODAL)})?.checkVisibility()`))
  await new Promise((r) => setTimeout(r, 300))
  t.check(
    '弹窗：按时间倒序列出 4 份',
    await t.js(`[...document.querySelectorAll('.archived-modal [data-testid="archived-row"]')].map((r) => r.dataset.path)`),
    [paths.REFACTOR, paths.WEEKLY, paths.WEEKLY_OLD, paths.OLD],
  )
  t.ok(
    '弹窗：对话写「对话」，项目写目录名',
    await t.js(`(() => {
      const meta = (p) => document.querySelector('.archived-modal [data-path="' + p + '"]').textContent
      return meta(${JSON.stringify(paths.WEEKLY)}).includes('对话 · ') && meta(${JSON.stringify(paths.REFACTOR)}).includes('repo · ')
    })()`),
  )
  await t.shot('modal')

  // —— 查看：只读弹窗，正文加载出来、没有输入框 ——
  await t.click(rowButton(paths.OLD, 'archived-view'), 10)
  t.ok('查看：只读弹窗打开', await t.waitUntil(`document.querySelector(${JSON.stringify(VIEWER)})?.checkVisibility()`))
  t.ok('查看：正文加载出来', await t.waitForText('[data-testid="archived-readonly-session"]', '版本号从 CI 变量读取'))
  t.ok('查看：读的是这一份会话', (await t.events()).includes(`view:${paths.OLD}`))
  t.check('查看：没有输入框', await t.count('.archived-viewer textarea, .archived-viewer [contenteditable="true"]'), 0)
  await t.shot('viewer')
  await t.click('.archived-viewer .ant-modal-close', 6)
  t.ok('查看：关掉', await t.waitUntil(`!document.querySelector(${JSON.stringify(VIEWER)})?.checkVisibility()`))

  // —— 取消归档：回到侧栏原来的项目里 ——
  await t.click(rowButton(paths.REFACTOR, 'archived-restore'), 10)
  t.ok('取消归档：弹窗里少了这一行', await t.waitUntil(`!document.querySelector('.archived-modal [data-path="${paths.REFACTOR}"]')`))
  t.ok('取消归档：主进程收到', (await t.events()).includes(`unarchive:${paths.REFACTOR}`))
  t.ok('取消归档：行回到侧栏', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.includes('重构订单查询'))`))
  t.check('取消归档：计数变成 3', await t.text('[data-testid="archived-count"]'), '3')

  // —— 删除：先确认，取消不删；确定才删 ——
  await t.click(rowButton(paths.OLD, 'archived-delete'), 10)
  t.ok('删除：弹出确认', await t.waitUntil(`document.querySelector(${JSON.stringify(CONFIRM)})?.checkVisibility()`))
  t.ok('删除：确认文案写出标题', ((await t.text(CONFIRM)) ?? '').includes('确定删除「旧的发布脚本」吗？'))
  await t.click('[data-testid="archived-delete-cancel"]', 10)
  await t.waitUntil(`!document.querySelector(${JSON.stringify(CONFIRM)})?.checkVisibility()`)
  t.check('删除：取消时不删', (await t.events()).some((e) => e.startsWith('delete:')), false)
  await t.click(rowButton(paths.OLD, 'archived-delete'), 10)
  await t.waitUntil(`document.querySelector(${JSON.stringify(CONFIRM)})?.checkVisibility()`)
  await new Promise((r) => setTimeout(r, 300))
  await t.click('[data-testid="archived-delete-confirm"]', 10)
  t.ok('删除：确定后删掉这一份', (await t.events()).includes(`delete:${paths.OLD}`))
  t.ok('删除：弹窗里少了这一行', await t.waitUntil(`!document.querySelector('.archived-modal [data-path="${paths.OLD}"]')`))
  t.check('删除：计数变成 2', await t.text('[data-testid="archived-count"]'), '2')

  // —— 浅色主题 ——
  await t.setTheme('light')
  await new Promise((r) => setTimeout(r, 300))
  // 弹窗里第一层有底色的容器（antd 各版本类名不同：content / container）
  const bg = await t.js(`(() => {
    const root = document.querySelector(${JSON.stringify(MODAL)})
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const c = getComputedStyle(el).backgroundColor
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c
    }
    return ''
  })()`)
  t.ok(`浅色：弹窗是浅底（${bg}）`, /rgba?\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}/.test(bg))
  await t.shot('modal-light')
  await t.key('Escape')
  t.ok('Esc 关掉弹窗', await t.waitUntil(`!document.querySelector(${JSON.stringify(MODAL)})?.checkVisibility()`))
  t.check('关掉后入口仍在（还有 2 份）', await t.countVisible('[data-testid="archived-entry"]'), 1)
  await t.shot('sidebar-light')
}
