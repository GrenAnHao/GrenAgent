/**
 * 前台 run 转到后台后的卡片：工具已经返回，转后台的子代理还在跑。
 * 覆盖：单任务卡按后台子代理画运行中（不是已完成或出错）；并行组里已完成的那项是已完成、转后台的那几项是运行中；
 * 卡片第一次读注册表时还没建出来的那一行不会被当成丢失；持续缺行和读取失败进入待确认，不算失败；
 * 转后台时还没 agentId 的那一行不能按同名任务猜测，工具结果按子索引补 id 后才跟上注册表；
 * 组头的后台计数消失、不出现失败计数；之后不再轮询。
 */

const GROUP = '[data-testid="subagent-group"]'
// 行号接着前面单任务卡的序号编，按组内顺序取。
const ROWS = `${GROUP} [data-testid^="subagent-group-row-"]`
const row = async (t, i) => (await t.texts(ROWS))[i] ?? ''
const rowHas = (i, text) => `[...document.querySelectorAll('${ROWS}')][${i}]?.textContent.includes('${text}')`
const BG = '[data-testid="subagent-group-background"]'
const queryCount = async (t) => (await t.events()).filter((event) => event === 'registry-list').length
const FAST = 0
const SLOW = 1
const LATE = 2
const GONE = 3
const QUEUED = 4
const FLAKY = 5
const CANCELLED = 6
const INTERRUPTED = 7

export default async function (t) {
  t.ok('卡片渲染出来', await t.waitFor('#detached-cards [data-testid="subagent-inline"]'))
  t.ok('并行组渲染出来', await t.waitFor(GROUP))

  // —— 转后台时 ——
  t.check('单任务：画成运行中（转圈）', await t.count('#detached-cards [data-testid="subagent-inline"] [data-role="run-spinner"]'), 1)
  t.ok('并行：已完成的那项是已完成', (await row(t, FAST)).includes('已完成'))
  t.ok('并行：转后台的那项是运行中，不是出错', !(await row(t, SLOW)).includes('出错'))
  t.ok('并行：登记后尚无正文，等待首响应', await t.waitUntil(rowHas(SLOW, '等待首响应'), 8000))
  t.ok('并行：明确取消显示中性「已停止」，不算失败', await t.waitUntil(rowHas(CANCELLED, '已停止'), 8000))
  t.ok('并行：明确中断显示中性「已中断」，不算失败', await t.waitUntil(rowHas(INTERRUPTED, '已中断'), 8000))
  t.ok('连续空按 ID 查询和一次读取失败后：仍是状态待确认', await t.waitUntil(rowHas(GONE, '状态待确认'), 15000))
  t.ok('已有运行记录随后失联：自动退避期间状态待确认', await t.waitUntil(rowHas(FLAKY, '状态待确认'), 12000))
  t.ok('已有运行记录失联不再算后台运行', !(await row(t, FLAKY)).includes('已中断'))
  t.ok('原终态 dock 回执不被较早 running 查询重新激活', await t.waitForText('[data-testid="terminal-dock-detail"]', '已完成回执') && !(await t.text('[data-testid="terminal-dock-detail"]')).includes('等待首响应'))
  t.ok('组头没有失败计数（缺行不算失败）', !(await t.text(GROUP)).includes('失败'))
  t.ok('dock 详情也显示状态待确认', await t.waitForText('[data-testid="detached-dock-detail"]', '状态待确认'))
  t.check('单卡／组卡／详情均无人工重试灰按钮', await t.count('[data-testid="subagent-retry"]'), 0)
  t.ok('第一次读注册表还没有的那项：晚到后等首响应', (await row(t, LATE)).includes('等待首响应'))
  t.ok('还没 agentId 的那项：只按父调用/子项位置保留未确认', (await row(t, QUEUED)).includes('状态待确认'))
  await t.sleep(3000)
  t.ok('下一次轮询读到晚到的那项：仍等待首响应', (await row(t, LATE)).includes('等待首响应'))
  t.ok('晚到与缺行子项从挂载起无误报终态', (await t.data()).watch?.flashedTerminal === false)

  // —— 已经开跑、最终 output 还没落盘 ——
  // 回归：只认最终 output 时，孩子干了几十个工具调用仍停在「等待首响应」。
  await t.act('firstActivity', 'sa-late')
  t.ok('登记行刚有首个实质活动（output 仍为空）：不再等待首响应', await t.waitUntil(
    `(() => { const r = [...document.querySelectorAll('${ROWS}')][${LATE}]?.textContent ?? ''; return !r.includes('等待首响应') && r.includes('正在处理'); })()`,
    8000,
  ))
  t.ok('同一次查询里已完成的那项仍按终态显示', (await row(t, FAST)).includes('已完成'))
  await t.shot('detached-running')

  // —— 注册表里结束之后 ——
  const single = '#detached-cards [data-testid="subagent-inline"]'
  const listCard = '[data-testid="subagent-card-sa-single"]'
  await t.act('bashWaiting')
  t.ok('回复完成时仍在等 Bash', await t.waitForText(single, '回复已完成 · 等待后台命令'))
  t.ok('列表显示同一等待状态', await t.waitForText(listCard, '回复已完成 · 等待后台命令'))
  t.check('等待仍是运行态图标', await t.count(`${single} [data-role="run-spinner"]`), 1)
  await t.shot('subagent-bash-waiting')
  await t.act('bashTimeout')
  t.ok('单任务与列表都说明是命令超时', await t.waitForText(single, '回复已完成 · 后台命令超时') && await t.waitForText(listCard, '回复已完成 · 后台命令超时'))
  t.check('命令超时用警示图标', await t.count(`${single} [data-status="warning"]`), 1)
  await t.click(`${single} button[aria-label="展开"]`)
  t.ok('展开显示未确认停止及完整回复', await t.waitForText(single, '停止未确认') && await t.waitForText(single, '完整的最终回复'))
  await t.shot('subagent-bash-timeout')
  await t.act('finish', 'sa-slow')
  await t.act('finish', 'sa-late')
  await t.act('add', 'sa-queued', '排队的任务')
  await t.act('assignQueued')
  t.ok('单任务：轮询到结束后不再转圈', await t.waitUntil(
    `document.querySelectorAll('#detached-cards [data-testid="subagent-inline"] [data-role="run-spinner"]').length === 0`, 8000))
  t.ok('并行：转后台的那项变成已完成', await t.waitUntil(rowHas(SLOW, '已完成'), 8000))
  t.ok('并行：晚到的那项变成已完成', await t.waitUntil(rowHas(LATE, '已完成'), 8000))
  t.ok('组头写「1 个在后台运行」（只剩排队的那项）', await t.waitForText(GROUP, '1 个在后台运行'))
  t.ok('排队的那项有稳定 id 后等首响应', await t.waitUntil(rowHas(QUEUED, '等待首响应'), 8000))
  await t.act('finish', 'sa-queued')
  t.ok('排队的那项按任务文字跟上注册表，变成已完成', await t.waitUntil(rowHas(QUEUED, '已完成'), 8000))
  t.check('组头的后台计数消失', await t.count(BG), 0)
  t.ok('组头仍没有失败计数', !(await t.text(GROUP)).includes('失败'))
  t.ok('未确认的那项仍不误报中断', (await row(t, GONE)).includes('状态待确认'))
  await t.act('recoverFlaky')
  t.ok('失联后自动退避最终取到明确终态', await t.waitUntil(rowHas(FLAKY, '已完成'), 35000))
  await t.shot('detached-finished')

  const settled = await queryCount(t)
  const missingLookups = (await t.events()).filter((event) => event === 'registry-lookup:sa-gone').length
  await t.sleep(5500)
  t.check('无 ID 组项预算用尽后不再轮询全量列表', await queryCount(t), settled)
  t.ok('未知 ID 仅共享退避对账，不每卡繁忙轮询', (await t.events()).filter((event) => event === 'registry-lookup:sa-gone').length - missingLookups <= 1)

  await t.act('enableOverflow')
  await t.click('[data-testid="subagent-menu-button"]')
  t.ok('第51行虽然未出现在限长列表，但按父会话ID确认后进入菜单', await t.waitFor('[data-testid="subagent-card-sa-overflow"]'))
  t.check('第51行按稳定ID去重，仅显示一张', await t.count('[data-testid="subagent-card-sa-overflow"]'), 1)
}
