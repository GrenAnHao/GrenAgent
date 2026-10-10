/**
 * codemode 卡片：标题摘要、嵌套调用列表（实时 / 历史两种来源）、展开后的脚本与输出、嵌套 MCP 结果。
 */

const at = (id) => `[data-case="${id}"]`

/** 一个 case 里调用列表的状态 / 服务器 / 是否来自实时嵌套事件 */
function callsOf(t, id) {
  return t.js(`[...document.querySelectorAll('${at(id)} [data-testid="codemode-call"]')].map((el) => ({
    status: el.dataset.status,
    live: el.dataset.live === '1',
    server: el.querySelector('[data-role="mcp-server"]')?.textContent ?? '',
    text: el.textContent,
  }))`)
}

/**
 * 点工具行：先滚到可视区，再点左侧 20px。行用 margin: 0 -7px 把 hover 底色往外扩，
 * 最外边那 7px 会被 ChatItemShell 裁掉，点 dx=6 会落到外层。
 */
async function clickRow(t, sel) {
  await t.js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`)
  await t.sleep(50)
  return t.click(sel, 20)
}

function noHorizontalOverflow(t, id) {
  return t.js(`(() => {
    const root = document.querySelector('${at(id)}')
    return [...root.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1).length
  })()`)
}

export default async function (t) {
  const { cases } = await t.data()
  for (const id of cases) await t.waitFor(`${at(id)} [data-testid="codemode-card"]`)
  await t.shot('collapsed')

  // —— 实时 · 完成 ——
  const done = at('live-done')
  t.ok('完成：标题是「运行脚本」', (await t.text(`${done} [data-testid="codemode-card"] [data-testid="tool-execution"]`))?.includes('运行脚本'))
  t.ok('完成：标题摘要列出被调用的 MCP 工具', (await t.text(`${done} [data-testid="codemode-summary"]`))?.includes('deepwiki.ask_wiki_question'))
  t.ok('完成：meta 显示调用次数', (await t.text(`${done} [data-testid="codemode-meta"]`))?.includes('3 次调用'))
  const doneCalls = await callsOf(t, 'live-done')
  t.check('完成：3 条嵌套调用都挂在卡片下', doneCalls.length, 3)
  t.check('完成：嵌套调用状态', doneCalls.map((c) => c.status), ['ok', 'ok', 'ok'])
  t.check('完成：嵌套调用来自实时事件', doneCalls.map((c) => c.live), [true, true, true])
  t.check('完成：服务器标签', doneCalls.map((c) => c.server), ['anysearch', 'deepwiki', 'antd'])
  t.ok('完成：查询参数读成人话', doneCalls[0]?.text.includes('antd 6 Splitter collapsible'))
  t.ok('完成：仓库 + 问题', doneCalls[1]?.text.includes('ant-design/ant-design'))
  t.check('完成：折叠态不出现 mcp__ 原名', (await t.text(done))?.includes('mcp__'), false)
  t.check('完成：顶层只有一张 codemode 卡', await t.count(`${done} [data-testid="codemode-card"]`), 1)
  t.ok('完成：嵌套耗时用 pi 记录的值', doneCalls[1]?.text.includes('2.4s'))

  // 展开 codemode：脚本 + 输出
  await clickRow(t, `${done} [data-testid="codemode-card"] > [data-testid="tool-execution"] > div`)
  await t.waitFor(`${done} [data-testid="codemode-output"]`)
  t.ok('展开：脚本可见', (await t.countVisible(`${done} [data-testid="codemode-script"]`)) === 1)
  await t.waitForText(`${done} [data-testid="codemode-script"]`, 'Promise.allSettled', 5000)
  t.ok('展开：脚本内容', (await t.text(`${done} [data-testid="codemode-script"]`))?.includes('Promise.allSettled'))
  const output = (await t.text(`${done} [data-testid="codemode-output"]`)) ?? ''
  t.check('展开：输出去掉 Script completed 头', output.includes('Script completed') || output.includes('Wall time'), false)
  await t.waitForText(`${done} [data-testid="codemode-output"]`, '"search": "fulfilled"', 5000)
  t.ok('展开：返回值 JSON 格式化', ((await t.text(`${done} [data-testid="codemode-output"]`)) ?? '').includes('"search": "fulfilled"'))
  t.ok('展开：文本输出保留', output.includes('Split panels to isolate content areas.'))
  t.check('展开：1.1.0 的 ==> text N/M <== 标记不显示', output.includes('==> text'), false)
  t.check('展开：<console_output> 标签不显示', output.includes('console_output'), false)
  t.check('展开：text() 与返回值拆成一个文本块 + 一个 JSON 块', [
    await t.count(`${done} [data-testid="codemode-output"] [data-block="text"]`),
    await t.count(`${done} [data-testid="codemode-output"] [data-block="json"]`),
  ], [1, 1])
  t.ok('展开：控制台输出单独成块', ((await t.text(`${done} [data-testid="codemode-output"] [data-block="console"]`)) ?? '').includes('wiki fulfilled'))
  t.check('展开：没有横向溢出', await noHorizontalOverflow(t, 'live-done'), 0)
  await t.shot('live-done-expanded')

  // 展开 deepwiki 嵌套调用：markdown 渲染 + 全文路径单独一行
  await clickRow(t, `${done} [data-testid="codemode-call"]:nth-child(2) [data-testid="tool-execution"] > div`)
  await t.waitFor(`${done} [data-testid="mcp-result"] h2`, 8000)
  t.ok('MCP：markdown 渲染出标题', (await t.text(`${done} [data-testid="mcp-result"] h2`))?.includes('Collapsible panels'))
  t.ok('MCP：全文路径单独显示', (await t.text(`${done} [data-testid="mcp-full-output"]`))?.includes('mcp-result-3c4d'))
  t.check('MCP：正文不含「全文:」尾巴', ((await t.text(`${done} [data-testid="mcp-result-body"]`)) ?? '').includes('全文:'), false)

  // 展开 anysearch：JSON 格式化
  await clickRow(t, `${done} [data-testid="codemode-call"]:nth-child(1) [data-testid="tool-execution"] > div`)
  await t.waitForText(`${done} [data-testid="codemode-call"]:nth-child(1) [data-testid="mcp-result"]`, '"results": [', 8000)
  t.ok('MCP：JSON 结果格式化', ((await t.text(`${done} [data-testid="codemode-call"]:nth-child(1) [data-testid="mcp-result"]`)) ?? '').includes('"results": ['))
  await t.shot('live-done-nested')

  // —— 实时 · 运行中 ——
  const run = at('live-running')
  const runCalls = await callsOf(t, 'live-running')
  t.check('运行中：调用状态（第 2 次还在跑）', runCalls.map((c) => c.status), ['ok', 'running'])
  t.ok('运行中：meta 显示调用中', (await t.text(`${run} [data-testid="codemode-meta"]`))?.includes('2 次调用'))
  t.check('运行中：卡片状态', await t.js(`document.querySelector('${run} [data-testid="codemode-card"] [data-status]')?.dataset.status`), 'running')

  // —— 实时 · 失败 ——
  const fail = at('live-failed')
  const failCalls = await callsOf(t, 'live-failed')
  t.check('失败：调用状态', failCalls.map((c) => c.status), ['ok', 'error'])
  t.ok('失败：meta 显示失败数', (await t.text(`${fail} [data-testid="codemode-meta"]`))?.includes('1 失败'))
  await clickRow(t, `${fail} [data-testid="codemode-card"] > [data-testid="tool-execution"] > div`)
  await t.waitFor(`${fail} [data-testid="codemode-error"]`)
  t.ok('失败：脚本错误单独标红', (await t.text(`${fail} [data-testid="codemode-error"]`))?.includes('not indexed'))
  t.check('失败：没有普通输出块', await t.count(`${fail} [data-testid="codemode-output"] [data-block="text"]`), 0)
  t.ok('失败：报错前的控制台输出单独成块', ((await t.text(`${fail} [data-testid="codemode-output"] [data-block="console"]`)) ?? '').includes('search fulfilled'))
  t.check('失败：错误块不带控制台内容', ((await t.text(`${fail} [data-testid="codemode-error"]`)) ?? '').includes('console_output'), false)
  const outRect = await t.rect(`${fail} [data-testid="codemode-output"]`)
  const scriptRect = await t.rect(`${fail} [data-testid="codemode-script"]`)
  t.ok('失败：输出（错误）排在脚本前面', outRect != null && scriptRect != null && outRect.y < scriptRect.y)
  await t.shot('live-failed-expanded')

  // —— 历史回放：没有嵌套事件，靠 details.calls ——
  const hist = at('history')
  const histCalls = await callsOf(t, 'history')
  t.check('历史：从 details.calls 还原 3 条调用', histCalls.length, 3)
  t.check('历史：调用状态', histCalls.map((c) => c.status), ['ok', 'ok', 'ok'])
  t.check('历史：不是实时行', histCalls.map((c) => c.live), [false, false, false])
  t.check('历史：服务器标签', histCalls.map((c) => c.server), ['anysearch', 'deepwiki', 'antd'])
  t.ok('历史：调用耗时', histCalls[1]?.text.includes('2.4s'))
  t.ok('历史：标题带脚本耗时', (await t.text(`${hist} [data-testid="codemode-card"] > [data-testid="tool-execution"] > div`))?.includes('3.4s'))

  // 失败的记录行可以展开看错误；成功的记录行没有可展开的内容
  t.check('历史：成功记录行不可展开', await t.js(`getComputedStyle(document.querySelector('${hist} [data-testid="codemode-call"] [data-testid="tool-execution"] > div')).cursor`), 'auto')
  await clickRow(t, `${hist} [data-testid="codemode-card"] > [data-testid="tool-execution"] > div`)
  await t.waitForText(`${hist} [data-testid="codemode-output"]`, '脚本耗时 3.4s', 5000)
  t.ok('历史：展开后输出标明脚本耗时', ((await t.text(`${hist} [data-testid="codemode-output"]`)) ?? '').includes('脚本耗时 3.4s'))
  await t.waitForText(`${hist} [data-testid="codemode-output"]`, '"search": "fulfilled"', 5000)
  const histOutput = (await t.text(`${hist} [data-testid="codemode-output"]`)) ?? ''
  t.ok('历史（1.0.2 形状）：console 行和文本合并显示', histOutput.includes('wiki fulfilled') && histOutput.includes('Split panels to isolate content areas.'))
  t.check('历史（1.0.2 形状）：没有控制台块', await t.count(`${hist} [data-testid="codemode-output"] [data-block="console"]`), 0)
  await t.shot('history-expanded')

  // —— 调用很多：只露最后 5 条，前面折成一行，点开全部 ——
  const many = at('many')
  const { manyCalls } = await t.data()
  t.check('很多：收起时露 5 条', await t.count(`${many} [data-testid="codemode-call"]`), 5)
  t.ok('很多：折叠行写出剩余次数', (await t.text(`${many} [data-testid="codemode-calls-more"]`))?.includes(`${manyCalls - 5} 次`))
  t.ok('很多：标题合并同名调用', (await t.text(`${many} [data-testid="codemode-summary"]`))?.includes(`antd.antd_doc ×${manyCalls}`))
  await t.js(`document.querySelector('${many} [data-testid="codemode-calls-more"]').scrollIntoView({ block: 'center' })`)
  await t.click(`${many} [data-testid="codemode-calls-more"]`)
  t.check('很多：点开后全部可见', await t.count(`${many} [data-testid="codemode-call"]`), manyCalls)
  t.check('很多：折叠行消失', await t.count(`${many} [data-testid="codemode-calls-more"]`), 0)

  await t.setTheme('light')
  await t.js(`document.querySelector('.harness-scroll').scrollTop = 0`)
  await t.sleep(100)
  const tagColor = (await t.style(`${hist} [data-role="mcp-server"]`, ['color'])).color ?? ''
  // 取数要带指数：计算值可能写成 9.96e-05，/[0-9.]+/ 会把它拆成两个数
  const channels = (tagColor.match(/-?[0-9.]+(?:e[-+]?[0-9]+)?/gi) ?? []).slice(0, 3).map(Number)
  t.ok(`浅色：服务器标签是深色字（${tagColor}）`, channels.length === 3 && channels.reduce((a, b) => a + b, 0) / 3 < 160)
  await t.shot('light')
}
