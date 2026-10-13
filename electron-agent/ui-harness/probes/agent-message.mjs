/**
 * send_message wake: false 的消息在对话里显示成「来自 X 的消息（未唤醒）」的提示条，不是通用的「已注入上下文」。
 * 覆盖：历史里的那条标题写出发送方、默认收起不露正文、点开看到正文、再点收起；普通注入通知仍是「已注入上下文」；
 * 实时推来的一条（走 reducer 的 message_start / message_end）同样显示、只显示一次，发送方是子代理；
 * 同样正文再发一次（另一条消息）也显示，不被当成重复；浅色主题。
 */

const PILL = '[data-testid="agent-message-pill"]'
const nth = (i) => `#timeline > div:nth-of-type(${i}) ${PILL}`

export default async function (t) {
  const data = await t.data()
  t.ok('对话渲染出来', await t.waitFor('#timeline'))
  t.ok('历史里的消息显示成提示条', await t.waitFor(PILL))
  t.check('历史里只有一条 agent-message 提示条', await t.count(PILL), 1)

  const title = await t.text(PILL)
  t.ok(`标题写出发送方（${title}）`, title.includes('来自 parent-1 的消息（未唤醒）'))
  t.ok('标题不是通用的「已注入上下文」', !title.includes('已注入上下文'))
  t.ok('默认收起：正文不露出来', !title.includes('.env.local'))
  t.ok('普通注入通知仍是「已注入上下文」', (await t.text('[data-testid="notice-pill"]'))?.includes('已注入上下文'))
  await t.shot('collapsed')

  await t.click(`${PILL} > *:first-child`, 20)
  t.ok('点开后看到正文', await t.waitForText(PILL, '.env.local'))
  t.ok('正文按 markdown 渲染（行内代码）', (await t.count(`${PILL} code`)) >= 1)
  await t.shot('expanded')
  await t.click(`${PILL} > *:first-child`, 20)
  t.ok('再点收起', await t.waitUntil(`!document.querySelector('${PILL}').textContent.includes('.env.local')`))

  // —— 实时：子代理 → 父会话 ——
  await t.act('pushLive')
  t.ok('实时推来的一条也显示成提示条', await t.waitUntil(`document.querySelectorAll('${PILL}').length === 2`))
  const liveTitle = (await t.texts(PILL))[1]
  t.ok(`实时那条的发送方是子代理（${liveTitle}）`, liveTitle.includes('来自 sa-7 的消息（未唤醒）'))
  t.info('实时正文', data.liveBody)
  await t.act('pushLive', 2)
  t.ok('同样正文再发一次（另一条消息）也显示，不被当成重复', await t.waitUntil(`document.querySelectorAll('${PILL}').length === 3`))

  // —— 浅色主题 ——
  await t.setTheme('light')
  t.check('浅色：三条提示条都在', await t.countVisible(PILL), 3)
  await t.shot('light')
}
