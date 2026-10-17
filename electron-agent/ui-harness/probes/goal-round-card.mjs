/**
 * Goal 每一轮续跑在对话里都有一张卡片：标题「目标续跑 · 第 N 轮」，不写轮次预算；默认收起，
 * 展开看到这一轮模型收到的完成条件，再点收起；别的 display:false 消息仍然不显示；
 * 实时推来的一轮（message_start + message_end）只出一张；浅色主题下仍可见。
 */

const CARD = '[data-testid="goal-round-pill"]'

export default async function (t) {
  const data = await t.data()
  t.ok('对话渲染出来', await t.waitFor('#timeline'))
  t.ok('历史里的续跑轮次显示成卡片', await t.waitFor(CARD))
  t.check('历史两轮各一张卡片', await t.count(CARD), 2)
  t.check('别的 display:false 消息不显示', await t.count('[data-testid="notice-pill"]'), 0)

  const titles = await t.texts(CARD)
  t.ok(`第一张写第 4 轮（${titles[0]}）`, titles[0].includes('目标续跑 · 第 4 轮'))
  t.ok(`第二张写第 5 轮（${titles[1]}）`, titles[1].includes('目标续跑 · 第 5 轮'))
  t.ok('标题不写轮次预算', !titles.some((title) => title.includes('256')))
  t.ok('默认收起：完成条件不露出来', !titles[0].includes('feat/kefu-m'))
  await t.shot('collapsed')

  const first = `#timeline > div:nth-of-type(1) ${CARD}`
  await t.click(`${first} > *:first-child`, 20)
  t.ok('点开后看到这一轮的完成条件', await t.waitForText(first, 'feat/kefu-m'))
  await t.shot('expanded')
  await t.click(`${first} > *:first-child`, 20)
  t.ok('再点收起', await t.waitUntil(`!document.querySelector('${first}').textContent.includes('feat/kefu-m')`))

  await t.act('pushLive', 6)
  t.ok('实时推来的第 6 轮也有卡片，且只出一张', await t.waitUntil(`document.querySelectorAll('${CARD}').length === 3`))
  t.ok('实时那张写第 6 轮', (await t.texts(CARD))[2].includes('目标续跑 · 第 6 轮'))
  t.info('完成条件', data.condition)

  await t.setTheme('light')
  t.check('浅色：三张卡片都可见', await t.countVisible(CARD), 3)
  await t.shot('light')
}
