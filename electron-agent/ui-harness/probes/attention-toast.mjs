/**
 * 应用内提示：Goal 续跑不冒完成；后台会话完成出提示、8 秒内自己收起；失败提示带报错，「前往」打开会话并收起；
 * 审批提示不自动收起、答复后收起，任务栏计数跟着变；当前会话（窗口在前台）不提示；浅色主题下提示是浅底。
 */

const TOAST = (kind) => `[data-testid="attention-toast"][data-kind="${kind}"]`
const ANY_TOAST = '[data-testid="attention-toast"]'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const visibleExpr = (sel) =>
  `[...document.querySelectorAll('${sel}')].some((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`

/** 自 mark 之后新记的事件 */
const eventsSince = async (t, mark) => (await t.events()).slice(mark)

/** 主题 token 的实际颜色：在提示自己的主题作用域里临时插一个 span 读计算色 */
const tokenColorIn = (t, hostSel, name) =>
  t.js(`(() => {
    const host = document.querySelector('${hostSel}')
    const probe = document.createElement('span')
    probe.style.color = 'var(--ant-${name})'
    host.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })()`)

export default async function (t) {
  t.ok('场景渲染出来', await t.waitFor('[data-testid="attention-stage"]'))
  const { titles } = await t.data()
  await t.mouse(2, 2)

  // —— Goal 续跑：一轮结束 300ms 后又开下一轮，不冒「完成」 ——
  let mark = (await t.events()).length
  await t.act('goalRound', 'B')
  await sleep(2500)
  t.check('Goal 续跑：没有发完成提醒', (await eventsSince(t, mark)).filter((e) => e.startsWith('notify:done')), [])
  t.check('Goal 续跑：没有提示', await t.countVisible(ANY_TOAST), 0)

  // —— 后台会话完成：宽限后出提示，8 秒内自己收起 ——
  mark = (await t.events()).length
  await t.act('finish', 'B')
  t.ok('完成：2.5 秒内出现提示', await t.waitFor(TOAST('done'), 2500))
  t.check('完成：主进程被问了一次', (await eventsSince(t, mark)).filter((e) => e === 'notify:done:B').length, 1)
  t.ok('完成：标题写会话名和状态', ((await t.text(TOAST('done'))) ?? '').includes(`${titles.B} · 已完成`))
  t.check('完成：不计入任务栏数字', (await eventsSince(t, mark)).filter((e) => e.startsWith('badge:')), [])
  // 等入场动画放完再量可见性、背景、截图（动画中不透明度接近 0）
  await sleep(400)
  t.check('完成：有「前往」按钮', await t.countVisible(`${TOAST('done')} [data-testid="attention-go"]`), 1)
  t.checkColor(
    '完成：深色主题下提示是深色浮层',
    (await t.style(TOAST('done'), ['background-color'])).backgroundColor,
    await tokenColorIn(t, TOAST('done'), 'color-bg-elevated')
  )
  await t.shot('done')
  t.ok('完成：10 秒内自己收起', await t.waitUntil(`!(${visibleExpr(TOAST('done'))})`, 10_000))

  // —— 失败：带报错，「前往」打开会话并收起 ——
  mark = (await t.events()).length
  await t.act('fail', 'B', '429 rate limited')
  t.ok('失败：出现提示', await t.waitFor(TOAST('failed'), 2000))
  t.ok('失败：正文是报错', ((await t.text(TOAST('failed'))) ?? '').includes('429 rate limited'))
  t.ok('失败：任务栏计数变成 1', (await eventsSince(t, mark)).includes('badge:1'))
  await t.click(`${TOAST('failed')} [data-testid="attention-go"]`, 20)
  t.ok('失败：「前往」打开了 B', (await eventsSince(t, mark)).includes('open:B'))
  t.ok('失败：提示收起', await t.waitUntil(`!(${visibleExpr(TOAST('failed'))})`, 3000))
  t.ok('失败：打开后未读清掉，任务栏计数回到 0', await t.waitUntil(`(window.__uiEvents ?? []).slice(${mark}).includes('badge:0')`, 2000))
  await t.act('activate', 'A')

  // —— 审批：不自动收起，答复后收起 ——
  mark = (await t.events()).length
  await t.act('approve', 'B')
  t.ok('审批：出现提示', await t.waitFor(TOAST('approval'), 2000))
  t.ok('审批：正文是审批标题', ((await t.text(TOAST('approval'))) ?? '').includes('执行 npm publish？'))
  t.ok('审批：标题写「等待批准」', ((await t.text(TOAST('approval'))) ?? '').includes(`${titles.B} · 等待批准`))
  t.ok('审批：任务栏计数变成 1', (await eventsSince(t, mark)).includes('badge:1'))
  await sleep(9000)
  t.check('审批：9 秒后仍在', await t.countVisible(TOAST('approval')), 1)
  await t.act('answer', 'B')
  t.ok('审批：答复后收起', await t.waitUntil(`!(${visibleExpr(TOAST('approval'))})`, 3000))
  t.ok('审批：任务栏计数回到 0', (await eventsSince(t, mark)).includes('badge:0'))

  // —— 当前会话、窗口在前台：不提示 ——
  mark = (await t.events()).length
  await t.act('approve', 'A')
  await sleep(800)
  t.check('当前会话：没有问主进程', (await eventsSince(t, mark)).filter((e) => e.startsWith('notify:')), [])
  t.check('当前会话：没有提示', await t.countVisible(ANY_TOAST), 0)
  await t.act('answer', 'A')

  // —— 浅色主题 ——
  await t.setTheme('light')
  await sleep(300)
  await t.act('fail', 'B', '请求超时')
  t.ok('浅色：出现失败提示', await t.waitFor(TOAST('failed'), 2000))
  await sleep(400)
  const notice = TOAST('failed')
  const bg = (await t.style(notice, ['background-color'])).backgroundColor
  t.checkColor('浅色：提示背景是浅色主题的浮层色', bg, await tokenColorIn(t, notice, 'color-bg-elevated'))
  await t.shot('light')
  await t.setTheme('dark')
}
