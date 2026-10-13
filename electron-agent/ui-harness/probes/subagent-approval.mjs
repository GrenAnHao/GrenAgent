/**
 * 子代理审批卡：子代理经父会话发来的审批（extensions/_shared/approval-route.ts）在输入框上方排队显示。
 * 覆盖：卡片标明是子代理、标题里写出是哪个子代理（孙代理带上父链）、按收到的时刻倒计时；
 * 几条同时来时只显示第一条并写「还有 N 条」，答完第一条下一条顶上来（双击不会顺手答掉顶上来的那条）；宿主收回（dismiss）显示中的那条，
 * 下一条顶上来；收回排队中的那条，显示中的不动；主会话自己的审批没有倒计时；剩 10 秒以内倒计时变警示色；浅色主题。
 */

const CARD = '[data-testid="prompt-request-approval"]'
const COUNTDOWN = '[data-testid="prompt-request-countdown"]'
const WAITING = '[data-testid="prompt-request-waiting"]'
const ALLOW_ONCE = '[data-testid="prompt-request-approval-allow-once"]'

const seconds = (text) => Number(/([0-9]+) 秒后视为拒绝/.exec(text ?? '')?.[1] ?? NaN)

export default async function (t) {
  t.ok('输入框占位渲染出来', await t.waitFor('[data-testid="fake-composer"]'))
  t.check('没有请求时没有审批卡', await t.countVisible(CARD), 0)

  // —— 第一条子代理请求 ——
  await t.act('childAsk', 'c1', 'sa-1', 'npm test')
  t.ok('子代理请求：卡片出现', await t.waitFor(CARD))
  t.ok('卡头写「子代理请求批准」', await t.waitForText(CARD, '子代理请求批准'))
  t.ok('正文写出是哪个子代理', (await t.text(CARD)).includes('子代理 run the tests（sa-1） 请求批准'))
  t.ok('正文带上命令', (await t.text(CARD)).includes('npm test'))
  const first = seconds(await t.text(COUNTDOWN))
  t.ok(`倒计时从 60 秒起（${first}）`, first >= 59 && first <= 60)
  t.check('只有一条时没有「还有 N 条」', await t.count(WAITING), 0)
  await t.shot('single')

  // —— 倒计时在走 ——
  await t.sleep(2200)
  const later = seconds(await t.text(COUNTDOWN))
  t.ok(`倒计时每秒往下走（${first} → ${later}）`, later <= first - 2 && later >= first - 3)

  // —— 再来一条子代理、一条主会话：排队 ——
  await t.act('childAsk', 'c2', 'sa-3', 'rm -rf dist')
  await t.act('mainAsk', 'm1', 'git push')
  t.ok('排队：显示「还有 2 条」', await t.waitForText(WAITING, '还有 2 条'))
  t.ok('排队：显示的仍是第一条', (await t.text(CARD)).includes('sa-1'))
  t.check('排队：同一时间只有一张审批卡', await t.countVisible(CARD), 1)
  await t.shot('queued')

  // —— 双击「允许本次」：只答第一条，第二下不落到顶上来的第二条上 ——
  await t.dblclick(ALLOW_ONCE, 20)
  t.ok('答复回传给宿主', (await t.events()).includes('respond:c1:允许本次'))
  await t.sleep(300)
  t.ok('双击的第二下没有答到顶上来的那条', !(await t.events()).some((e) => e.startsWith('respond:c2')))
  t.ok('第二条顶上来：孙代理带上父链', await t.waitForText(CARD, '子代理 clean build output（sa-2） › remove dist（sa-3） 请求批准'))
  t.ok('还剩 1 条在排队', await t.waitForText(WAITING, '还有 1 条'))
  t.ok('第二条也有倒计时', (await t.countVisible(COUNTDOWN)) === 1)

  // —— 宿主收回显示中的那条（例如超时），主会话的顶上来 ——
  await t.act('dismiss', 'c2')
  t.ok('dismiss 后主会话的审批顶上来', await t.waitForText(CARD, 'git push'))
  t.ok('主会话的卡头仍是「需要批准」', (await t.text(CARD)).includes('需要批准'))
  t.check('主会话的审批没有倒计时', await t.count(COUNTDOWN), 0)
  t.check('队列空了：没有「还有 N 条」', await t.count(WAITING), 0)
  t.ok('收回的那条没有回传答复', !(await t.events()).some((e) => e.startsWith('respond:c2')))

  // —— 收回排队中的那条：显示中的不动 ——
  await t.act('childAsk', 'c3', 'sa-1', 'npm run lint')
  t.ok('排队：还有 1 条', await t.waitForText(WAITING, '还有 1 条'))
  await t.act('dismiss', 'c3')
  t.ok('收回排队中的那条后队列空了', await t.waitUntil(`!document.querySelector('${WAITING}')`))
  t.ok('显示中的主会话审批不动', (await t.text(CARD)).includes('git push'))
  // 换卡之后 400ms 内不认点击：等过这段再点
  await t.sleep(450)
  await t.click(ALLOW_ONCE, 20)
  t.ok('全部答完卡片消失', await t.waitUntil(`!document.querySelector('${CARD}')`))

  // —— 快到点：警示色 ——
  await t.act('childAsk', 'c4', 'sa-2', 'rm -rf build', 8000)
  t.ok('短超时的请求出现', await t.waitForText(CARD, 'rm -rf build'))
  await t.act('childAsk', 'c5', 'sa-1', 'npm test')
  t.ok('后面再排一条', await t.waitForText(WAITING, '还有 1 条'))
  const urgent = (await t.style(COUNTDOWN, ['color'])).color
  const calm = (await t.style(WAITING, ['color'])).color
  t.ok(`剩 10 秒以内倒计时换成警示色（${urgent} ≠ ${calm}）`, urgent !== calm)
  await t.shot('urgent')

  // —— 浅色主题 ——
  await t.setTheme('light')
  t.check('浅色：审批卡仍在', await t.countVisible(CARD), 1)
  t.check('浅色：倒计时仍在', await t.countVisible(COUNTDOWN), 1)
  const lightUrgent = (await t.style(COUNTDOWN, ['color'])).color
  t.ok(`浅色：警示色跟着主题变（${urgent} → ${lightUrgent}）`, lightUrgent !== urgent)
  await t.shot('light')
}
