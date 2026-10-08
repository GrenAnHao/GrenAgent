/**
 * 侧栏会话行：运行中的行悬停时，「更多」在转圈的原位出现，不挤动标题；移开变回转圈。
 * 覆盖：静止时只有转圈、没有按钮；悬停（含鼠标正好停在转圈上）转圈让位给「更多」，
 * 标题宽度不变、按钮中心就是转圈原来的位置、转圈所在格和按钮同尺寸；
 * 点按钮只开菜单、不触发整行点击，点行本身仍然打开会话；移开后变回转圈；空闲行的「更多」和运行行在同一列。
 */

const ROW = (id) => `[data-testid="${id}"] .pi-session-row`
const TITLE = (id) => `${ROW(id)} > span:first-child`
const CELL = (id) => `[data-testid="${id}"] [data-running]`
const SPIN = (id) => `[data-testid="${id}"] [data-testid="session-running"]`
const MORE = (id) => `[data-testid="${id}"] [role="button"]`

const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const MENU_OPEN = `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`

export default async function (t) {
  t.ok('会话行渲染出来', await t.waitFor(ROW('running-row')))
  await t.mouse(2, 2)

  // —— 静止：只看得到转圈 ——
  t.check('静止：运行中的行有转圈', await t.countVisible(SPIN('running-row')), 1)
  t.check('静止：「更多」不可见', await t.countVisible(MORE('running-row')), 0)
  t.check('静止：空闲行没有转圈', await t.count(SPIN('idle-row')), 0)
  const rest = {
    title: await t.rect(TITLE('running-row')),
    cell: await t.rect(CELL('running-row')),
    spin: await t.rect(SPIN('running-row'))
  }
  // 转圈在转，包围盒会变，但中心不动
  t.checkNear('静止：转圈在它的格子正中（x）', mid(rest.spin).x, mid(rest.cell).x, 2)
  t.checkNear('静止：转圈在它的格子正中（y）', mid(rest.spin).y, mid(rest.cell).y, 2)
  await t.shot('rest')

  // —— 悬停整行：转圈让位给「更多」，原位互换 ——
  await t.hover(ROW('running-row'), 40)
  t.check('悬停：转圈让位', await t.countVisible(SPIN('running-row')), 0)
  t.check('悬停：「更多」出现', await t.countVisible(MORE('running-row')), 1)
  const hot = {
    title: await t.rect(TITLE('running-row')),
    cell: await t.rect(CELL('running-row')),
    more: await t.rect(MORE('running-row'))
  }
  t.checkNear('悬停：标题宽度不变（没有被挤开）', hot.title.w, rest.title.w, 0.5)
  t.check('悬停：占位的格子没有动', hot.cell, rest.cell)
  t.checkNear('悬停：「更多」中心就是转圈原来的位置（x）', mid(hot.more).x, mid(rest.spin).x, 2)
  t.checkNear('悬停：「更多」中心就是转圈原来的位置（y）', mid(hot.more).y, mid(rest.spin).y, 2)
  t.checkNear('转圈所在格和「更多」同宽', rest.cell.w, hot.more.w, 0.5)
  t.checkNear('转圈所在格和「更多」同高', rest.cell.h, hot.more.h, 0.5)
  t.ok('悬停：点得到「更多」（没被隐藏的转圈盖住）', await t.hitTest(MORE('running-row')))
  await t.shot('hover')

  // —— 移开：变回转圈 ——
  await t.mouse(2, 2)
  t.check('移开：转圈回来', await t.countVisible(SPIN('running-row')), 1)
  t.check('移开：「更多」收起', await t.countVisible(MORE('running-row')), 0)
  t.checkNear('移开：标题宽度不变', (await t.rect(TITLE('running-row'))).w, rest.title.w, 0.5)

  // —— 鼠标正好停在转圈上 ——
  await t.hover(CELL('running-row'), rest.cell.w / 2)
  t.check(
    '停在转圈上：转圈换成「更多」',
    [await t.countVisible(SPIN('running-row')), await t.countVisible(MORE('running-row'))],
    [0, 1]
  )
  t.ok('停在转圈上：鼠标下面就是「更多」', await t.hitTest(MORE('running-row')))
  t.checkNear('停在转圈上：标题宽度不变', (await t.rect(TITLE('running-row'))).w, rest.title.w, 0.5)

  // —— 点「更多」只开菜单，不触发整行点击 ——
  await t.click(MORE('running-row'), rest.cell.w / 2)
  t.ok('点「更多」：弹出菜单', await t.waitUntil(MENU_OPEN))
  t.check('点「更多」：没有触发整行点击', (await t.events()).includes('open:running-row'), false)
  await t.click({ x: 2, y: 2 })
  t.ok('点空白处：菜单收起', await t.waitUntil(`!(${MENU_OPEN})`))

  // —— 点行本身仍然打开会话 ——
  await t.click(ROW('running-row'), 40)
  t.check('点行本身：打开这个会话', (await t.events()).filter((e) => e === 'open:running-row').length, 1)

  // —— 空闲行：照旧悬停才出现「更多」，位置和运行行同一列 ——
  t.check('空闲行静止：没有按钮', await t.countVisible(MORE('idle-row')), 0)
  await t.hover(ROW('idle-row'), 40)
  t.check('空闲行悬停：出现「更多」', await t.countVisible(MORE('idle-row')), 1)
  t.checkNear('空闲行的「更多」和运行行在同一列', (await t.rect(MORE('idle-row'))).right, hot.more.right, 1)
  await t.mouse(2, 2)
}
