/**
 * 侧栏最顶层分区（置顶 / 对话 / 项目）折叠：点区头标题收起 / 展开、箭头只在收起或悬停时出现、
 * 键盘 Enter / Space、区头新建入口不触发折叠且会展开本区、置顶区收起时再置顶一项会自动展开、
 * 折叠状态写进 localStorage、区头几何和原来对齐、浅色主题。
 */

const SEC = (id) => `[data-testid="sidebar-section"][data-section="${id}"]`
const TOGGLE = (id) => `${SEC(id)} [data-testid="sidebar-section-toggle"]`
const CARET = (id) => `${SEC(id)} [data-testid="sidebar-section-caret"]`
const ROWS = '[data-testid="sidebar"] .pi-session-row'
const PROJECT_ROWS = '[data-testid="sidebar"] [data-testid="project-row"]'
const NEW_CONV = '[data-testid="sidebar-new-conversation"]'
const NEW_PROJ = '[data-testid="sidebar-new-project"]'
const MENU_OPEN = `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`

const q = JSON.stringify

const sectionOrder = (t) => t.js(`[...document.querySelectorAll('[data-testid="sidebar-section"]')].map((el) => el.dataset.section)`)
const expanded = (t, id) => t.js(`document.querySelector(${q(TOGGLE(id))})?.getAttribute('aria-expanded')`)
const caretOpacity = async (t, id) => Number((await t.style(CARET(id), ['opacity']))?.opacity)
const hasRow = (t, title) => t.js(`[...document.querySelectorAll(${q(ROWS)})].some((r) => r.textContent.includes(${q(title)}))`)
const projectNames = (t) => t.js(`[...document.querySelectorAll(${q(PROJECT_ROWS)})].map((r) => r.textContent.trim())`)
const storedSections = (t) => t.js(`JSON.parse(localStorage.getItem('pi-sidebar') ?? '{}').state?.collapsedSections ?? null`)

/** 标题包含 title 的会话行落在哪个分区里（按区头的纵向位置判断）；没有这一行返回 null。 */
const sectionOf = (t, title) =>
  t.js(`(() => {
    const row = [...document.querySelectorAll(${q(ROWS)})].find((r) => r.textContent.includes(${q(title)}))
    if (!row) return null
    const y = row.getBoundingClientRect().top
    let owner = null
    for (const sec of document.querySelectorAll('[data-testid="sidebar-section"]')) {
      if (sec.getBoundingClientRect().top <= y) owner = sec.dataset.section
    }
    return owner
  })()`)

const rowPoint = (t, title) =>
  t.js(`(() => {
    const el = [...document.querySelectorAll(${q(ROWS)})].find((r) => r.textContent.includes(${q(title)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + 40, y: r.y + r.height / 2 }
  })()`)

const menuItem = (label) =>
  `(() => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${q(label)} && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })))()`

async function clickMenuItem(t, label) {
  const p = await t.js(`(() => { const el = ${menuItem(label)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 } })()`)
  if (!p) return null
  return t.click(p)
}

const countEvents = async (t, name) => (await t.events()).filter((e) => e === name).length

export default async function (t) {
  t.ok('侧栏渲染出来', await t.waitFor(SEC('projects')))
  await t.mouse(2, 2)

  // —— 初始：三个区头按顺序、全部展开、箭头不显示 ——
  t.check('初始：区头顺序 置顶 / 对话 / 项目', await sectionOrder(t), ['pinned', 'conversations', 'projects'])
  for (const id of ['pinned', 'conversations', 'projects']) {
    t.check(`初始：${id} 展开（aria-expanded）`, await expanded(t, id), 'true')
    t.checkNear(`初始：${id} 不悬停时箭头不显示`, await caretOpacity(t, id), 0, 0.01)
  }
  t.check('初始：「整理依赖」在置顶区', await sectionOf(t, '整理依赖'), 'pinned')
  t.check('初始：「写周报」在对话区', await sectionOf(t, '写周报'), 'conversations')
  t.check('初始：「修复登录页」在项目区', await sectionOf(t, '修复登录页'), 'projects')

  // —— 几何：标题位置沿用原来的 14px 缩进，新建按钮和标题同一行居中，区头高 28px ——
  const geo = await t.js(`(() => {
    const side = document.querySelector('[data-testid="sidebar"]').getBoundingClientRect()
    const sec = document.querySelector(${q(SEC('conversations'))})
    const label = sec.querySelector('[data-testid="sidebar-section-toggle"] span')
    const toggle = sec.querySelector('[data-testid="sidebar-section-toggle"]').getBoundingClientRect()
    const l = label.getBoundingClientRect()
    const btn = sec.querySelector(${q(NEW_CONV)}).getBoundingClientRect()
    return { left: l.left - side.left, dy: Math.abs((l.top + l.height / 2) - (btn.top + btn.height / 2)), h: toggle.height, gap: btn.left - toggle.right }
  })()`)
  t.checkNear('几何：区头标题距侧栏左沿 14px（和原来一致）', geo.left, 14, 1)
  t.checkNear('几何：新建对话按钮和标题垂直居中对齐', geo.dy, 0, 1)
  t.checkNear('几何：区头可点区域高 28px', geo.h, 28, 0.5)
  t.ok(`几何：可点区域一直铺到新建按钮左边（间距 ${geo.gap}px）`, geo.gap >= 0 && geo.gap <= 6)
  t.ok('几何：新建对话按钮点得到', await t.hitTest(NEW_CONV))
  await t.shot('initial')

  // —— 悬停：只有这一个区头出箭头 ——
  await t.hover(TOGGLE('conversations'))
  t.checkNear('悬停对话区头：箭头出现', await caretOpacity(t, 'conversations'), 1, 0.01)
  t.checkNear('悬停对话区头：项目区头箭头仍不显示', await caretOpacity(t, 'projects'), 0, 0.01)
  t.ok('悬停对话区头：展开时是向下的箭头', await t.count(`${CARET('conversations')} svg.lucide-chevron-down`) === 1)
  await t.shot('hover-header')
  await t.mouse(2, 2)

  // —— 点标题收起对话区 ——
  await t.click(TOGGLE('conversations'))
  t.check('收起对话：aria-expanded 变 false', await expanded(t, 'conversations'), 'false')
  t.ok('收起对话：「写周报」「翻译文档」不在侧栏', !(await hasRow(t, '写周报')) && !(await hasRow(t, '翻译文档')))
  t.ok('收起对话：区头和新建按钮还在', (await t.countVisible(SEC('conversations'))) === 1 && (await t.countVisible(NEW_CONV)) === 1)
  t.checkNear('收起对话：鼠标移开后箭头仍显示', await caretOpacity(t, 'conversations'), 1, 0.01)
  t.ok('收起对话：箭头朝右', await t.count(`${CARET('conversations')} svg.lucide-chevron-right`) === 1)
  t.ok('收起对话：项目区不受影响', (await hasRow(t, '修复登录页')) && (await expanded(t, 'projects')) === 'true')
  t.check('收起对话：写进 localStorage', await storedSections(t), { conversations: true })
  const stack = await t.js(`(() => {
    const a = document.querySelector(${q(SEC('conversations'))}).getBoundingClientRect()
    const b = document.querySelector(${q(SEC('projects'))}).getBoundingClientRect()
    return b.top - a.bottom
  })()`)
  t.checkNear('收起对话：项目区头紧接在对话区头下面', stack, 0, 1)
  await t.shot('conversations-collapsed')

  // —— 点标题右边的空白处同样展开 ——
  const blank = await t.js(`(() => { const r = document.querySelector(${q(TOGGLE('conversations'))}).getBoundingClientRect(); return { x: Math.round(r.right - 8), y: Math.round(r.top + r.height / 2) } })()`)
  await t.click(blank)
  t.check('点区头空白处：对话区展开', await expanded(t, 'conversations'), 'true')
  t.ok('展开对话：两条对话回来了', (await hasRow(t, '写周报')) && (await hasRow(t, '翻译文档')))
  // t.click 点完只等 80ms 就把鼠标移开，箭头的 0.15s 淡出还没放完
  await t.sleep(300)
  t.checkNear('展开对话：鼠标移开后箭头隐藏（点过的焦点不让它挂着）', await caretOpacity(t, 'conversations'), 0, 0.01)

  // —— 新建对话按钮：展开时不折叠；收起时点它先展开 ——
  await t.click(NEW_CONV, 12)
  t.check('展开时点新建对话：触发新建', await countEvents(t, 'new-conversation'), 1)
  t.check('展开时点新建对话：对话区没被收起', await expanded(t, 'conversations'), 'true')
  await t.click(TOGGLE('conversations'))
  t.check('再次收起对话', await expanded(t, 'conversations'), 'false')
  await t.click(NEW_CONV, 12)
  t.check('收起时点新建对话：触发新建', await countEvents(t, 'new-conversation'), 2)
  t.check('收起时点新建对话：对话区展开', await expanded(t, 'conversations'), 'true')
  t.ok('收起时点新建对话：对话行回来了', await hasRow(t, '写周报'))

  // —— 键盘：区头可聚焦，Enter / Space 切换 ——
  await t.click(TOGGLE('projects'))
  t.check('点击收起项目区', await expanded(t, 'projects'), 'false')
  t.check('收起项目：项目行都不在', await projectNames(t), [])
  t.ok('收起项目：置顶的「整理依赖」仍在置顶区', (await sectionOf(t, '整理依赖')) === 'pinned')
  t.ok('点击后焦点在项目区头上', await t.js(`document.activeElement === document.querySelector(${q(TOGGLE('projects'))})`))
  await t.key('Return')
  t.check('Enter：项目区展开', await expanded(t, 'projects'), 'true')
  t.ok('Enter：项目行回来了', (await projectNames(t)).length === 2)
  t.checkNear('Enter 之后：键盘聚焦的区头展开时也显示箭头', await caretOpacity(t, 'projects'), 1, 0.01)
  await t.key('Space')
  t.check('Space：项目区收起', await expanded(t, 'projects'), 'false')

  // —— 新建项目：打开下拉不展开，选了菜单项才展开 ——
  await t.click(NEW_PROJ, 10)
  t.ok('新建项目：下拉菜单弹出', await t.waitUntil(MENU_OPEN))
  t.check('新建项目：只打开下拉时项目区仍收起', await expanded(t, 'projects'), 'false')
  await clickMenuItem(t, '使用现有文件夹')
  t.check('新建项目：选菜单项触发打开项目', await countEvents(t, 'open-project'), 1)
  t.check('新建项目：项目区展开', await expanded(t, 'projects'), 'true')
  t.ok('新建项目：项目行回来了', (await projectNames(t)).length === 2)

  // —— 置顶区：收起后置顶的会话哪里都不出现；再置顶一项自动展开 ——
  await t.click(TOGGLE('pinned'))
  t.check('收起置顶区', await expanded(t, 'pinned'), 'false')
  t.check('收起置顶：「整理依赖」不在侧栏（不回到原项目）', await hasRow(t, '整理依赖'), false)
  t.ok('收起置顶：项目里其他会话照常', (await hasRow(t, '修复登录页')) && (await hasRow(t, '重构订单查询')))
  await t.shot('pinned-collapsed')
  await t.rightClick(await rowPoint(t, '重构订单查询'))
  t.ok('置顶菜单弹出', await t.waitUntil(MENU_OPEN))
  await clickMenuItem(t, '置顶')
  t.check('置顶一项：置顶区自动展开', await expanded(t, 'pinned'), 'true')
  t.check('置顶一项：刚置顶的「重构订单查询」在置顶区', await sectionOf(t, '重构订单查询'), 'pinned')
  t.check('置顶一项：原来的「整理依赖」也回来了', await sectionOf(t, '整理依赖'), 'pinned')
  t.check('折叠状态都写进 localStorage', await storedSections(t), { conversations: false, projects: false, pinned: false })

  // —— 浅色主题 ——
  await t.click(TOGGLE('conversations'))
  await t.setTheme('light')
  t.checkNear('浅色：收起的区头箭头仍显示', await caretOpacity(t, 'conversations'), 1, 0.01)
  await t.shot('light')
  await t.click(TOGGLE('conversations'))
  t.check('浅色：再展开对话区', await expanded(t, 'conversations'), 'true')
}
