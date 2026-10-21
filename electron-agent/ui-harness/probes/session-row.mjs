/**
 * 侧栏会话行：运行中的行悬停时，「更多」在转圈的原位出现，不挤动标题；移开变回转圈。
 * 覆盖：静止时只有转圈、没有按钮；悬停（含鼠标正好停在转圈上）转圈让位给「更多」，
 * 标题宽度不变、按钮中心就是转圈原来的位置、转圈所在格和按钮同尺寸；
 * 点按钮只开菜单、不触发整行点击，点行本身仍然打开会话；移开后变回转圈；空闲行的「更多」和运行行在同一列。
 * 注意状态：五种角标的图标与颜色（对照主题 token）、审批压过转圈、选择在呼吸；悬停时角标让位给「更多」且位置不变；
 * 整行悬停 400ms 后出状态 Tooltip（长报错截断），不到 400ms 不出；折叠分组头有汇总角标和数字，展开的没有；浅色主题颜色跟着变。
 */

const ROW = (id) => `[data-testid="${id}"] .pi-session-row`
const TITLE = (id) => `${ROW(id)} > span:first-child`
const CELL = (id) => `[data-testid="${id}"] [data-running]`
const SPIN = (id) => `[data-testid="${id}"] [data-testid="session-running"]`
const MORE = (id) => `[data-testid="${id}"] [role="button"]`

const BADGE = (id) => `[data-testid="${id}"] [data-testid="session-attention"]`
const TOOLTIP = '.ant-tooltip'

const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** 主题 token 的实际颜色：在主题作用域里临时插一个 span 读计算色。 */
const tokenColor = (t, name) =>
  t.js(`(() => {
    const host = document.querySelector('[data-testid="failed-row"]')
    const probe = document.createElement('span')
    probe.style.color = 'var(--ant-${name})'
    host.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })()`)
const iconColor = async (t, id) => (await t.style(`${BADGE(id)} [data-attention-icon]`, ['color'])).color
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

  // —— 注意状态角标 ——
  const { tooltips } = await t.data()
  for (const kind of ['approval', 'choice', 'failed', 'blocked', 'done']) {
    t.check(`角标：${kind} 行有一个可见角标`, await t.countVisible(BADGE(`${kind}-row`)), 1)
    t.check(
      `角标：${kind} 行的 data-kind`,
      await t.js(`document.querySelector(${JSON.stringify(BADGE(`${kind}-row`))})?.dataset.kind`),
      kind
    )
  }
  t.check('角标：审批压过转圈（在跑的审批行没有转圈）', await t.count(SPIN('approval-row')), 0)
  t.checkColor('颜色：等待批准是橙色', await iconColor(t, 'approval-row'), await tokenColor(t, 'orange'))
  t.checkColor('颜色：需要选择是蓝色（info）', await iconColor(t, 'choice-row'), await tokenColor(t, 'color-info'))
  t.checkColor('颜色：失败是红色（error）', await iconColor(t, 'failed-row'), await tokenColor(t, 'color-error'))
  t.checkColor('颜色：受阻是紫色', await iconColor(t, 'blocked-row'), await tokenColor(t, 'purple'))
  t.checkColor(
    '颜色：完成是绿色圆点（success）',
    (await t.style(`${BADGE('done-row')} [data-attention-icon]`, ['background-color'])).backgroundColor,
    await tokenColor(t, 'color-success')
  )
  t.ok('颜色：橙色和运行中的黄色不是同一种', !t.colorNear(await tokenColor(t, 'orange'), await tokenColor(t, 'color-warning'), 4))
  t.check(
    '动画：需要选择在呼吸',
    (await t.style(`${BADGE('choice-row')} [data-attention-icon]`, ['animation-name'])).animationName !== 'none',
    true
  )
  const doneRect = await t.rect(`${BADGE('done-row')} [data-attention-icon]`)
  t.check('完成：圆点 8×8', [doneRect.w, doneRect.h], [8, 8])
  await t.shot('attention-rest')

  // 悬停审批行：角标让位给「更多」，原位互换
  const badgeRest = await t.rect(BADGE('approval-row'))
  await t.hover(ROW('approval-row'), 40)
  t.check('悬停审批行：角标让位', await t.countVisible(BADGE('approval-row')), 0)
  t.check('悬停审批行：「更多」出现', await t.countVisible(MORE('approval-row')), 1)
  const approvalMore = await t.rect(MORE('approval-row'))
  t.checkNear('悬停审批行：「更多」中心就是角标原来的位置（x）', mid(approvalMore).x, mid(badgeRest).x, 2)
  t.checkNear('悬停审批行：「更多」中心就是角标原来的位置（y）', mid(approvalMore).y, mid(badgeRest).y, 2)
  t.ok('悬停审批行：点得到「更多」', await t.hitTest(MORE('approval-row')))
  await t.mouse(2, 2)
  t.ok('移开：Tooltip 收起', await t.waitUntil(`![...document.querySelectorAll('${TOOLTIP}')].some((el) => !el.closest('.ant-tooltip-hidden') && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`))

  // Tooltip：悬停不到 400ms 不出，过了 400ms 出，长报错截断
  // t.hover 自己停 240ms：返回时还在 400ms 的延迟里
  await t.hover(ROW('failed-row'), 40)
  t.check('Tooltip：悬停约 240ms 还没出来', await t.countVisible(TOOLTIP), 0)
  await new Promise((r) => setTimeout(r, 400))
  t.ok('Tooltip：悬停超过 400ms 出现', await t.waitUntil(`[...document.querySelectorAll('${TOOLTIP}')].some((el) => !el.closest('.ant-tooltip-hidden') && el.checkVisibility())`))
  const tipText = await t.js(
    `[...document.querySelectorAll('${TOOLTIP}')].filter((el) => !el.closest('.ant-tooltip-hidden') && el.checkVisibility()).map((el) => el.textContent).join('|')`
  )
  t.check('Tooltip：文案是「失败：<截断的报错>」', tipText, tooltips.failed)
  t.ok('Tooltip：长报错以「…」结尾', tooltips.failed.endsWith('…'))
  await t.shot('attention-tooltip')
  await t.mouse(2, 2)
  t.ok(
    'Tooltip：移开后收起',
    await t.waitUntil(`![...document.querySelectorAll('${TOOLTIP}')].some((el) => !el.closest('.ant-tooltip-hidden') && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`)
  )

  // 折叠分组头汇总
  t.check('分组头：折叠的有汇总角标', await t.countVisible('[data-testid="collapsed-project"] [data-testid="project-attention"]'), 1)
  t.check('分组头：汇总数字是 2', await t.text('[data-testid="collapsed-project"] [data-testid="project-attention-count"]'), '2')
  t.check('分组头：展开的没有汇总', await t.count('[data-testid="expanded-project"] [data-testid="project-attention"]'), 0)

  // 整区收起的区头汇总（真实 sessionAttention store）
  const SECTION = '[data-testid="collapsed-section"] [data-testid="sidebar-section-attention"]'
  t.check('分区：收起的区头有汇总角标', await t.countVisible(SECTION), 1)
  t.check('分区：汇总取最高优先级（需要选择）', await t.js(`document.querySelector('${SECTION}')?.dataset.kind`), 'choice')
  t.check('分区：汇总数字是 2', await t.text('[data-testid="collapsed-section"] [data-testid="sidebar-section-attention-count"]'), '2')
  t.check('分区：展开的区头没有汇总', await t.count('[data-testid="expanded-section"] [data-testid="sidebar-section-attention"]'), 0)
  const sectionLabel = await t.rect('[data-testid="collapsed-section"] [data-testid="sidebar-section-toggle"] span')
  const sectionBadge = await t.rect(SECTION)
  t.ok('分区：汇总在标题右边、垂直居中', sectionBadge.x >= sectionLabel.right && Math.abs(sectionBadge.y + sectionBadge.h / 2 - (sectionLabel.y + sectionLabel.h / 2)) <= 2)

  // 浅色主题
  await t.setTheme('light')
  await new Promise((r) => setTimeout(r, 300))
  t.checkColor('浅色：失败角标仍是 error 色', await iconColor(t, 'failed-row'), await tokenColor(t, 'color-error'))
  t.checkColor('浅色：审批角标仍是橙色', await iconColor(t, 'approval-row'), await tokenColor(t, 'orange'))
  await t.shot('attention-light')
  await t.setTheme('dark')
}
