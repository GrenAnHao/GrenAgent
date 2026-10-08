/**
 * 后台 bash 卡片：折叠行的状态、展开后的终端与底栏、输出帧追加、停止、结束，以及任务已不在时的回退。
 * 数据形状照真实会话里 bash + run_in_background 的结果造。
 */

const at = (id) => `[data-case="${id}"]`

/** 先滚到可视区，再点左侧 20px（行用 margin: 0 -7px 往外扩，最外边 7px 会被外层裁掉）。 */
async function clickRow(t, sel) {
  await t.js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`)
  await t.sleep(50)
  return t.click(sel, 20)
}

/** 行首状态图标（StatusGlyph 的 data-status）。 */
function glyphOf(t, id) {
  return t.js(`document.querySelector('${at(id)} [data-testid="tool-execution"] [data-status]')?.dataset.status ?? null`)
}

export default async function (t) {
  const { cases, live, done, gone, foreground, sandboxJob } = await t.data()
  for (const id of cases) await t.waitFor(`${at(id)} [data-testid="tool-execution"]`)
  await t.shot('collapsed')

  // —— 折叠态：行上要看得出后台状态 ——
  const liveRow = `${at('live')} [data-testid="tool-execution"]`
  const historyRow = `${at('history')} [data-testid="tool-execution"]`
  const goneRow = `${at('gone')} [data-testid="tool-execution"]`

  t.check('实时：这条是 bash 命令行', ((await t.text(liveRow)) ?? '').includes('Run regression suite in background'), true)
  await t.waitFor(`${at('live')} [data-testid="bash-job-meta"]`, 5000)
  t.check('实时：折叠行 meta 显示「后台运行中」', await t.text(`${at('live')} [data-testid="bash-job-meta"]`), '后台运行中')
  await t.waitFor(`${at('history')} [data-testid="bash-job-meta"]`, 5000)
  t.check('历史：折叠行 meta 显示「后台已完成」', await t.text(`${at('history')} [data-testid="bash-job-meta"]`), '后台已完成')
  // 行图标跟着后台任务走：调用瞬间就返回了，但任务还在跑时不能显示成 ✓ 已完成。
  t.check('实时：任务在跑，行图标是 running，不是 ✓', await glyphOf(t, 'live'), 'running')
  t.check('历史：任务已结束，行图标是 done', await glyphOf(t, 'history'), 'done')
  t.check('任务已不在：沿用调用本身的状态 done', await glyphOf(t, 'gone'), 'done')
  // 时长：在跑的任务从任务开始起算，不能停在调用本身的 0s。
  const liveDuration = (await t.text(`${at('live')} [data-testid="tool-run-duration"]`)) ?? ''
  t.ok(`实时：时长按任务起算，不是 0s（现在是「${liveDuration.trim()}」）`, liveDuration.trim() !== '· 0s' && /h|m/.test(liveDuration))
  t.check('历史：时长定格在任务自己的耗时', (await t.text(`${at('history')} [data-testid="tool-run-duration"]`))?.trim(), '· 8m40s')
  // 任务已不在：行上没有状态可显示，但不能整行消失。
  t.check('任务已不在：折叠行不显示后台状态', await t.count(`${at('gone')} [data-testid="bash-job-meta"]`), 0)
  t.check('任务已不在：命令行本身仍在', await t.count(goneRow), 1)

  // —— 实时：展开 ——
  await clickRow(t, liveRow + ' > div')
  await t.waitFor(`${at('live')} [data-testid="bash-job-status"]`, 5000)
  t.check('实时：底栏写出任务 id 和状态', await t.text(`${at('live')} [data-testid="bash-job-status"]`), `后台任务 ${live} · 运行中`)
  t.check('实时：运行中有「停止」按钮', await t.countVisible(`${at('live')} [data-testid="bash-job-stop"]`), 1)
  t.ok('实时：终端里有快照里已有的输出', ((await t.text(at('live'))) ?? '').includes('RUN  v4.1.11'))
  await t.shot('live-expanded')

  // —— 实时：后续输出帧追加 ——
  await t.act('pushOutput', live, ' ✓ src/stores/sessionStream.test.ts (7 tests)\n')
  await t.waitForText(at('live'), 'sessionStream.test.ts (7 tests)', 5000)
  t.ok('实时：新输出帧追加到终端，旧输出还在', ((await t.text(at('live'))) ?? '').includes('RUN  v4.1.11'))
  t.check('实时：追加后仍是运行中', await t.text(`${at('live')} [data-testid="bash-job-meta"]`), '后台运行中')

  // —— 实时：点停止 ——
  await t.click(`${at('live')} [data-testid="bash-job-stop"]`)
  await t.waitForText(`${at('live')} [data-testid="bash-job-status"]`, '正在停止', 5000)
  t.ok('停止：job_kill 带着 jobId 发出去了', (await t.events()).includes(`kill:${live}`))
  t.check('停止：停止中不再显示按钮', await t.countVisible(`${at('live')} [data-testid="bash-job-stop"]`), 0)
  t.check('停止：折叠行跟着变成「后台正在停止」', await t.text(`${at('live')} [data-testid="bash-job-meta"]`), '后台正在停止')
  t.check('停止：正在停止仍是 running', await glyphOf(t, 'live'), 'running')

  // —— 实时：结束 ——
  await t.act('finish', live, 'exit code: 0')
  await t.waitForText(`${at('live')} [data-testid="bash-job-meta"]`, '后台已完成', 5000)
  t.check('结束：后台任务完成后自动收起终端', await t.count(`${at('live')} [data-testid="terminal-block"]`), 0)
  t.check('结束：折叠行变成「后台已完成」', await t.text(`${at('live')} [data-testid="bash-job-meta"]`), '后台已完成')
  t.check('结束：行图标变成 done', await glyphOf(t, 'live'), 'done')
  t.check('结束：时长定格在任务耗时 15m', (await t.text(`${at('live')} [data-testid="tool-run-duration"]`))?.trim(), '· 15m')
  await t.shot('live-finished')
  await clickRow(t, liveRow + ' > div')
  await t.waitFor(`${at('live')} [data-testid="bash-job-status"]`, 5000)
  t.check('结束：仍能手动打开查看最终状态', await t.text(`${at('live')} [data-testid="bash-job-status"]`), `后台任务 ${live} · 已完成`)
  await t.act('pushOutput', live, 'Summary complete\n')
  await t.waitForText(at('live'), 'Summary complete', 5000)
  t.check('结束：手动重开后后续结果更新保持展开', await t.count(`${at('live')} [data-testid="terminal-block"]`), 1)

  // —— 历史：展开，输出来自注册表快照 ——
  await clickRow(t, historyRow + ' > div')
  await t.waitFor(`${at('history')} [data-testid="bash-job-status"]`, 5000)
  t.check('历史：底栏写出任务 id 和状态', await t.text(`${at('history')} [data-testid="bash-job-status"]`), `后台任务 ${done} · 已完成`)
  t.ok('历史：终端里是注册表里的输出', ((await t.text(at('history'))) ?? '').includes('524 passed'))
  t.check('历史：已结束没有「停止」按钮', await t.countVisible(`${at('history')} [data-testid="bash-job-stop"]`), 0)
  await t.act('pushOutput', done, 'History summary\n')
  await t.waitForText(at('history'), 'History summary', 5000)
  t.check('历史：手动展开后更新结果保持展开', await t.count(`${at('history')} [data-testid="terminal-block"]`), 1)

  // —— 任务已不在：回退到工具结果，并说明原因 ——
  await clickRow(t, goneRow + ' > div')
  await t.waitFor(`${at('gone')} [data-testid="bash-job-missing"]`, 5000)
  t.ok('不在：底栏说明任务已不在', ((await t.text(`${at('gone')} [data-testid="bash-job-missing"]`)) ?? '').includes(gone))
  t.ok('不在：回退显示工具结果正文', ((await t.text(at('gone'))) ?? '').includes('started background job'))
  await t.shot('gone-expanded')

  // —— 前台命令：运行中就是匿名 job（DSH 的前台匿名管道） ——
  const fg = at('foreground')
  // 运行中的前台命令默认展开，不用点。
  await t.waitFor(`${fg} [data-testid="bash-job-status"]`, 5000)
  t.check('前台：行图标是 running', await glyphOf(t, 'foreground'), 'running')
  t.ok('前台：运行中默认展开，终端里是 job 的保留输出', ((await t.text(fg)) ?? '').includes('PASS a.test.ts'))
  // 模型没拿到这个 id，它也不是后台任务：底栏只说状态，不写 id，行上也没有「后台…」。
  t.check('前台：底栏只说状态，不写 job id', await t.text(`${fg} [data-testid="bash-job-status"]`), '运行中')
  t.check('前台：行上没有「后台运行中」', await t.count(`${fg} [data-testid="bash-job-meta"]`), 0)
  t.check('前台：运行中有「停止」按钮', await t.countVisible(`${fg} [data-testid="bash-job-stop"]`), 1)

  // 输出帧实时追加
  await t.act('pushOutput', foreground, 'PASS b.test.ts\n')
  await t.waitForText(fg, 'PASS b.test.ts', 5000)
  t.ok('前台：新输出帧追加，旧输出还在', ((await t.text(fg)) ?? '').includes('PASS a.test.ts'))
  await t.shot('foreground-running')

  // 停止只发 job_kill，不是停整个回合
  await t.click(`${fg} [data-testid="bash-job-stop"]`)
  await t.waitForText(`${fg} [data-testid="bash-job-status"]`, '正在停止', 5000)
  t.ok('前台停止：job_kill 带着这条匿名 job 的 id 发出去了', (await t.events()).includes(`kill:${foreground}`))

  // 命令结束：自动收起；手动重开后显示最终结果（匿名，没有 job 引用）
  await t.act('endForeground', foreground, 'PASS a.test.ts\nPASS b.test.ts\n')
  await t.waitUntil(async () => (await t.count(`${fg} [data-testid="bash-job-stop"]`)) === 0, 5000)
  t.check('前台结束：不再有「停止」按钮', await t.count(`${fg} [data-testid="bash-job-stop"]`), 0)
  t.check('前台结束：行图标变成 done', await glyphOf(t, 'foreground'), 'done')
  t.check('前台结束：自动收起终端', await t.count(`${fg} [data-testid="terminal-block"]`), 0)
  await clickRow(t, `${fg} [data-testid="tool-execution"] > div`)
  await t.waitFor(`${fg} [data-testid="terminal-block"]`, 5000)
  t.ok('前台结束：终端里是最终结果', ((await t.text(fg)) ?? '').includes('PASS b.test.ts'))
  t.check('前台结束：最终结果里没有 job id', ((await t.text(fg)) ?? '').includes(foreground), false)
  await t.shot('foreground-ended')

  // —— 前台命令：找不到 job（界面重载、记录已离开）：静默回退到 partial 文本 ——
  const gone2 = at('foreground-gone')
  await t.waitForText(gone2, 'still running', 5000)
  t.ok('前台找不到 job：终端里是 partial 文本', ((await t.text(gone2)) ?? '').includes('still running'))
  t.check('前台找不到 job：不说「任务已不在」', await t.count(`${gone2} [data-testid="bash-job-missing"]`), 0)
  t.check('前台找不到 job：没有停止按钮', await t.count(`${gone2} [data-testid="bash-job-stop"]`), 0)
  t.check('前台找不到 job：行图标仍是 running', await glyphOf(t, 'foreground-gone'), 'running')

  // —— 沙箱事实：前台被拒 ——
  const denied = at('denied')
  t.check('沙箱拒绝：行图标是 error', await glyphOf(t, 'denied'), 'error')
  t.check('沙箱拒绝：折叠行写明被拒和模式', await t.text(`${denied} [data-testid="bash-sandbox-meta"]`), '沙箱拒绝 · 只读')
  if ((await t.count(`${denied} [data-testid="bash-sandbox-note"]`)) === 0) {
    await clickRow(t, `${denied} [data-testid="tool-execution"] > div`)
  }
  await t.waitFor(`${denied} [data-testid="bash-sandbox-note"]`, 5000)
  t.check('沙箱拒绝：底栏一句中文说明', await t.text(`${denied} [data-testid="bash-sandbox-note"]`), '沙箱拦下了文件访问（只读模式）')
  t.ok('沙箱拒绝：终端正文仍是给模型的文本', ((await t.text(denied)) ?? '').includes('[sandbox: file access denied under read-only mode]'))
  await t.shot('sandbox-denied')

  // —— 沙箱事实：已升权 ——
  const escalated = at('escalated')
  t.check('已升权：行图标是 done', await glyphOf(t, 'escalated'), 'done')
  t.check('已升权：折叠行写明这次用的权限', await t.text(`${escalated} [data-testid="bash-sandbox-meta"]`), '已升权 · 工作区写入')
  if ((await t.count(`${escalated} [data-testid="bash-sandbox-note"]`)) === 0) {
    await clickRow(t, `${escalated} [data-testid="tool-execution"] > div`)
  }
  await t.waitFor(`${escalated} [data-testid="bash-sandbox-note"]`, 5000)
  t.check('已升权：底栏说明本次已获批准', await t.text(`${escalated} [data-testid="bash-sandbox-note"]`), '本次已获批准，以工作区写入权限运行')

  // —— 沙箱事实：后台任务被拒，底栏不直接贴给模型的英文标记 ——
  const jobDenied = at('job-denied')
  await t.waitFor(`${jobDenied} [data-testid="bash-job-meta"]`, 5000)
  t.check('后台被拒：非零退出，行图标是 error', await glyphOf(t, 'job-denied'), 'error')
  await clickRow(t, `${jobDenied} [data-testid="tool-execution"] > div`)
  await t.waitFor(`${jobDenied} [data-testid="bash-job-status"]`, 5000)
  t.check(
    '后台被拒：底栏是中文说明',
    await t.text(`${jobDenied} [data-testid="bash-job-status"]`),
    `后台任务 ${sandboxJob} · 已结束，退出码 1 · 沙箱拒绝（只读）`
  )
  t.check(
    '后台被拒：底栏不出现升权提示原文',
    ((await t.text(`${jobDenied} [data-testid="bash-job-status"]`)) ?? '').includes('escalation available'),
    false
  )
  await t.js(`document.querySelector('${jobDenied} [data-testid="bash-job-status"]')?.scrollIntoView({ block: 'center' })`)
  await t.sleep(50)
  await t.shot('sandbox-job-denied')

  t.check('页面没有错误边界兜底', await t.count('[data-testid="error-boundary-fallback"]'), 0)
}
