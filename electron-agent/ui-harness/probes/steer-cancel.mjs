/**
 * 等待中的引导：悬停气泡，焦点操作栏是「取消引导」（X）、「编辑」、「复制」，回合在跑也在；
 * 点 X 按正文发 agent_cancel_steer，Pi 撤下后气泡去掉、输入框不动；
 * 点编辑先取消，撤下后原文和图片回到输入框；
 * Pi 说已经在注入时气泡留着、输入框不动；已经注入的引导没有取消；浅色主题下 X 可见。
 */

const msg = (id) => `[data-msg-id="${id}"]`
const bar = (id) => `${msg(id)} [data-testid="message-action-bar"]`
const btn = (id, key) => `${msg(id)} [data-testid="msg-action-bar-${key}"]`

export default async function (t) {
  const { ids } = await t.data()
  t.ok('对话渲染出来', await t.waitFor('#timeline'))
  t.check('一条已引导、三条等待中，都有引导状态', await t.count('[data-testid="steer-status"]'), 4)

  // 悬停才浮现：先确认静止时操作栏是透明的，悬停后变成不透明。
  const restOpacity = (await t.style(`${msg(ids.login)} .chat-actions`, ['opacity'])).opacity
  t.check('静止时操作栏不显示', restOpacity, '0')
  await t.hover(`${msg(ids.login)} [data-testid="steer-status"]`)
  t.ok(
    '悬停后操作栏浮现',
    await t.waitUntil(`getComputedStyle(document.querySelector('${msg(ids.login)} .chat-actions')).opacity === '1'`),
  )
  const keys = await t.js(`[...document.querySelectorAll('${bar(ids.login)} [data-testid^="msg-action-bar-"]')].map((el) => el.dataset.testid.replace('msg-action-bar-', ''))`)
  t.check('等待中的引导操作栏是 取消 / 编辑 / 复制', keys.join(','), 'cancel,edit,copy')
  t.check('没有「更多」菜单', await t.count(`${bar(ids.login)} [aria-label="更多"]`), 0)
  t.check('X 的名字是「取消引导」', await t.js(`document.querySelector('${btn(ids.login, 'cancel')}').getAttribute('aria-label')`), '取消引导')
  await t.shot('hover-pending')

  // 点 X：只撤这一条，不碰输入框。
  await t.click(btn(ids.login, 'cancel'), 10)
  t.ok('点 X 后这条气泡去掉', await t.waitUntil(`!document.querySelector('${msg(ids.login)}')`))
  t.ok('按正文发了 agent_cancel_steer（还有别的等待中引导，不按唯一一条撤）', (await t.events()).includes('cancel:再补登录态:exact'))
  t.check('取消不往输入框里放', await t.text('#composer-text'), '')
  t.ok('别的等待中引导还在', (await t.count(msg(ids.chrome))) === 1 && (await t.count(msg(ids.inFlight))) === 1)

  // 已经在注入：撤不回来，气泡留着。
  await t.hover(`${msg(ids.inFlight)} [data-testid="steer-status"]`)
  await t.click(btn(ids.inFlight, 'edit'), 10)
  t.ok('Pi 说已经在注入：发了撤回请求', await t.waitUntil(`(window.__uiEvents ?? []).some((e) => e.startsWith('cancel:已经在注入的那条'))`))
  t.ok('提示撤不回来', await t.waitForText('body', '撤不回来'))
  t.check('撤不回来时气泡留着', await t.count(msg(ids.inFlight)), 1)
  t.check('撤不回来时编辑不往输入框里放', await t.text('#composer-text'), '')

  // 编辑：先取消，再把原文和图片放回输入框。
  await t.hover(`${msg(ids.chrome)} [data-testid="steer-status"]`)
  await t.click(btn(ids.chrome, 'edit'), 10)
  t.ok('编辑后这条气泡去掉', await t.waitUntil(`!document.querySelector('${msg(ids.chrome)}')`))
  t.ok('编辑先走了取消', (await t.events()).some((e) => e.startsWith('cancel:改用 chrome')))
  t.ok('原文回到输入框', await t.waitForText('#composer-text', '改用 chrome'))
  t.check('图片回到待发附件', await t.text('#composer-images'), '1')
  await t.shot('after-edit')

  // 已经注入的引导：操作栏照旧，没有取消。
  await t.hover(`${msg(ids.consumed)} [data-testid="steer-status"]`)
  t.check('已引导的消息没有取消按钮', await t.count(btn(ids.consumed, 'cancel')), 0)

  await t.setTheme('light')
  await t.hover(`${msg(ids.inFlight)} [data-testid="steer-status"]`)
  t.ok(
    '浅色：悬停后 X 可见',
    await t.waitUntil(`getComputedStyle(document.querySelector('${msg(ids.inFlight)} .chat-actions')).opacity === '1'`),
  )
  t.check('浅色：X 在操作栏里', await t.countVisible(btn(ids.inFlight, 'cancel')), 1)
  await t.shot('light')
}
