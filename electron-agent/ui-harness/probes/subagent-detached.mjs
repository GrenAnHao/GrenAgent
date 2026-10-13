/**
 * 前台 run 转到后台后的卡片：工具已经返回，转后台的子代理还在跑。
 * 覆盖：单任务卡按后台子代理画运行中（不是已完成或出错）；并行组里已完成的那项是已完成、转后台的那几项是运行中；
 * 卡片第一次读注册表时还没建出来的那一行不会被当成丢失；注册表里确实没有的那一行画「已中断」，不算失败、不算在后台；
 * 转后台时还没 agentId 的那一行按任务文字跟上注册表；注册表里它们结束后，卡片经轮询变成已完成，
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

export default async function (t) {
  t.ok('卡片渲染出来', await t.waitFor('#detached-cards [data-testid="subagent-inline"]'))
  t.ok('并行组渲染出来', await t.waitFor(GROUP))

  // —— 转后台时 ——
  t.check('单任务：画成运行中（转圈）', await t.count('#detached-cards [data-testid="subagent-inline"] [data-role="run-spinner"]'), 1)
  t.ok('并行：已完成的那项是已完成', (await row(t, FAST)).includes('已完成'))
  t.ok('并行：转后台的那项是运行中，不是出错', !(await row(t, SLOW)).includes('出错'))
  t.ok('并行：转后台的那项在处理中', (await row(t, SLOW)).includes('正在处理'))
  t.ok('注册表里确实没有的那项：画「已中断」', await t.waitUntil(rowHas(GONE, '已中断'), 8000))
  t.ok('组头写「3 个在后台运行」（已中断的不算）', await t.waitForText(GROUP, '3 个在后台运行'))
  t.ok('组头没有失败计数（已中断的不算失败）', !(await t.text(GROUP)).includes('失败'))
  t.ok('第一次读注册表时还没有的那项：不当成丢失，仍在处理', (await row(t, LATE)).includes('正在处理'))
  t.ok('还没 agentId 的那项：在处理中', (await row(t, QUEUED)).includes('正在处理'))
  await t.sleep(3000)
  t.ok('下一次轮询读到晚到的那项：仍在处理', (await row(t, LATE)).includes('正在处理'))
  t.ok('晚到的那项从挂载起一次也没画成已中断', (await t.data()).watch?.lateFlashedInterrupted === false)
  await t.shot('detached-running')

  // —— 注册表里结束之后 ——
  await t.act('finish', 'sa-single')
  await t.act('finish', 'sa-slow')
  await t.act('finish', 'sa-late')
  await t.act('add', 'sa-queued', '排队的任务')
  t.ok('单任务：轮询到结束后不再转圈', await t.waitUntil(
    `document.querySelectorAll('#detached-cards [data-testid="subagent-inline"] [data-role="run-spinner"]').length === 0`, 8000))
  t.ok('并行：转后台的那项变成已完成', await t.waitUntil(rowHas(SLOW, '已完成'), 8000))
  t.ok('并行：晚到的那项变成已完成', await t.waitUntil(rowHas(LATE, '已完成'), 8000))
  t.ok('组头写「1 个在后台运行」（只剩排队的那项）', await t.waitForText(GROUP, '1 个在后台运行'))
  t.ok('排队的那项在注册表里起来后仍在处理', (await row(t, QUEUED)).includes('正在处理'))
  await t.act('finish', 'sa-queued')
  t.ok('排队的那项按任务文字跟上注册表，变成已完成', await t.waitUntil(rowHas(QUEUED, '已完成'), 8000))
  t.check('组头的后台计数消失', await t.count(BG), 0)
  t.ok('组头仍没有失败计数', !(await t.text(GROUP)).includes('失败'))
  t.ok('已中断的那项仍是已中断', (await row(t, GONE)).includes('已中断'))
  await t.shot('detached-finished')

  const settled = await queryCount(t)
  await t.sleep(5500)
  t.check('都结束后不再轮询注册表', await queryCount(t), settled)
}
