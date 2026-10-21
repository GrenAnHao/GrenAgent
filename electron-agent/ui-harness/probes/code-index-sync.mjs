/**
 * 代码索引的自动同步呈现：
 * - 增量同步期间（phase syncing）标签写「同步中」，搜索框可用、文件列表照常查出来；标签的 title 带同步阶段与进度。
 * - 调度器推进期间页面静默轮询状态：标签一帧也不闪「检查中」；回到空闲后统计数字更新、轮询停下。
 * - 被别的程序占锁：「等待重试」+ 几秒后自动重试的说明，不是失败。
 * - 全量重建（state indexing）：「索引中」，搜索框不可用；轮询拿到熔断后的失败：横幅写明自动同步已暂停，轮询停下。
 * - 文件监听不可用：横幅提示需要手动同步。
 */

const TAG = '[data-testid="code-index-state"]'
const INPUT = 'input[aria-label="搜索代码"]'
const ROWS = '[data-code-list] [aria-pressed]'
const MORE = 'button[aria-label="代码索引更多操作"]'
const PANEL = '[data-testid="code-retrieval-panel"]'

const statusReads = async (t) => (await t.events()).filter((event) => event.startsWith('status:')).length

async function refreshStatus(t) {
  await t.click(MORE, 12)
  await t.waitUntil(`[...document.querySelectorAll('.ant-dropdown-menu-item')].some((n) => n.textContent.includes('刷新状态') && n.getBoundingClientRect().height > 0)`)
  await t.js(`(() => {
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')].find((n) => n.textContent.includes('刷新状态'))
    item.setAttribute('data-probe-node', 'refresh-status')
  })()`)
  await t.click('[data-probe-node="refresh-status"]', 20)
}

export default async function (t) {
  const data = await t.data()

  // —— 增量同步中：可查 ——
  t.ok('标签写「同步中」', await t.waitForText(TAG, '同步中'))
  t.ok('同步中仍能查询：文件列表查出来了', await t.waitFor(ROWS))
  t.check('同步中搜索框可用', await t.js(`document.querySelector('${INPUT}').disabled`), false)
  t.check('标签 title 带阶段与进度', await t.js(`document.querySelector('${TAG}').getAttribute('title')`), '解析代码 3/8')
  t.ok('增量同步不出「正在重建索引」横幅', !(await t.text(PANEL)).includes('正在重建索引'))

  // —— 静默轮询：不闪「检查中」 ——
  const before = await statusReads(t)
  const frames = await t.sample(`document.querySelector('${TAG}')?.textContent ?? ''`, 3500)
  const after = await statusReads(t)
  t.ok(`轮询期间标签一帧也没变成「检查中」（${frames.length} 帧）`, frames.length > 30 && frames.every((text) => text === '同步中'))
  t.ok(`同步中按间隔重读状态（3.5 秒内 ${after - before} 次）`, after - before >= 2 && after - before <= 4)

  // —— 同步结束：数字更新、轮询停下 ——
  await t.act('set', 'idle')
  t.ok('同步结束后标签回到「已索引」', await t.waitForText(TAG, '已索引', 4000))
  t.ok('统计数字换成新的文件数', (await t.text(PANEL)).includes(`${data.files + 2} 文件`))
  const settled = await statusReads(t)
  await t.sleep(3200)
  t.check('回到空闲后不再轮询', await statusReads(t), settled)

  // —— 被别的程序占锁：等待重试，不是失败 ——
  await t.act('set', 'locked')
  await refreshStatus(t)
  t.ok('占锁时标签写「等待重试」', await t.waitForText(TAG, '等待重试', 4000))
  const lockedText = await t.text(PANEL)
  t.ok('横幅说明另一个程序在写索引、几秒后自动重试', /另一个程序正在写这个项目的索引（codegraph\.lock），\d+ 秒后自动重试/.test(lockedText))
  t.ok('占锁时不显示「索引失败」', !lockedText.includes('索引失败'))
  t.check('占锁时搜索框仍可用', await t.js(`document.querySelector('${INPUT}').disabled`), false)

  // —— 退避期间也在轮询：轮询拿到全量重建 ——
  await t.act('set', 'rebuilding')
  t.ok('轮询拿到全量重建：标签「索引中」', await t.waitForText(TAG, '索引中', 4000))
  t.ok('全量重建横幅写明暂不能查询', (await t.text(PANEL)).includes('正在重建索引，完成前暂不能查询'))
  t.check('全量重建期间搜索框不可用', await t.js(`document.querySelector('${INPUT}').disabled`), true)

  // —— 轮询拿到熔断：失败横幅、轮询停下 ——
  await t.act('set', 'failed')
  t.ok('轮询拿到熔断后的失败：标签「索引失败」', await t.waitForText(TAG, '索引失败', 4000))
  t.ok('横幅写明连续失败次数与自动同步已暂停', (await t.text(PANEL)).includes('parse exploded（已连续失败 6 次，自动同步已暂停；修改文件或手动同步后再试）'))
  const stopped = await statusReads(t)
  await t.sleep(3200)
  t.check('熔断后不再轮询', await statusReads(t), stopped)

  // —— 文件监听不可用 ——
  await t.act('set', 'degraded')
  await refreshStatus(t)
  t.ok('监听不可用时标签仍是「已索引」', await t.waitForText(TAG, '已索引', 4000))
  t.ok('横幅提示监听不可用、需要手动同步', await t.waitForText(PANEL, '文件监听不可用（EMFILE: too many open files），索引不会自动跟上改动，需要时请手动同步', 4000))

  await t.shot('code-index-sync')
}
