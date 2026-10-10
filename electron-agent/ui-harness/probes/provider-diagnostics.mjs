/**
 * 供应商详情两层：上层设置（单独滚动），下层模型测活（贴住详情列底边）。
 * 测活：思考档位按模型映射列出；发送中出现取消，取消命中当前请求、保留已收到的正文、不出指标；
 * Ctrl+Enter 发送；完成后标题栏显示成功与耗时、指标含思考 tokens。
 * 分隔条上拖变高、拖到顶给设置层留高度；标题栏收起 / 展开；内置供应商也能测；浅色主题截图。
 */

const DOCK = '[data-testid="prov-diagnostics"]'
const BODY = '[data-testid="prov-diag-body"]'
const HEADER = '[data-testid="prov-diag-toggle"]'
const OPEN_OPTIONS = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'

/** 测活层、它上面的设置滚动区、整列详情的几何 */
const geometry = `(() => {
  const dock = document.querySelector('${DOCK}')
  const scroll = dock.previousElementSibling
  const column = dock.parentElement
  const r = (el) => {
    const b = el.getBoundingClientRect()
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), cx: Math.round(b.left + b.width / 2) }
  }
  return { dock: r(dock), scroll: r(scroll), column: r(column), scrollTop: scroll.scrollTop, scrollMax: scroll.scrollHeight - scroll.clientHeight }
})()`

const levelText = `document.querySelector('[data-testid="prov-diag-level"]').closest('.ant-select').textContent`

export default async function (t) {
  t.ok('供应商列表渲染', await t.waitFor('[data-testid="prov-item-relay"]'))
  await t.click('[data-testid="prov-item-relay"]', 20)
  t.ok('切到自定义供应商', await t.waitUntil(`document.querySelector('[data-testid="prov-name"]')?.value === 'Relay 中转'`))
  t.ok('测活层模型就绪', await t.waitUntil(`document.querySelector('[data-testid="prov-diag-run"]')?.disabled === false`))

  // —— 两层布局 ——
  let g = await t.js(geometry)
  t.info('布局', g)
  t.checkNear('设置层底边接测活层顶边', g.dock.top, g.scroll.bottom, 1)
  t.checkNear('测活层贴住详情列底边', g.dock.bottom, g.column.bottom, 1)
  t.checkNear('测活正文默认 300px 高', (await t.rect(BODY)).h, 300, 1)
  t.ok('设置层内容超出、可单独滚动', g.scrollMax > 0)

  await t.wheel({ x: g.scroll.cx, y: g.scroll.top + 80 }, 400)
  const scrolled = await t.js(geometry)
  t.ok('滚设置层：设置内容滚动', scrolled.scrollTop > 0)
  t.check('滚设置层：测活层位置不变', scrolled.dock.top, g.dock.top)

  // —— 思考档位 ——
  t.ok('思考档默认关闭', (await t.js(levelText)).includes('关闭'))
  await t.click('[data-testid="prov-diag-level"]', 20)
  t.ok('档位下拉打开', await t.waitFor(OPEN_OPTIONS))
  t.check('档位按模型映射列出（null 隐藏、原生名不同附上）', await t.texts(`${OPEN_OPTIONS} .ant-select-item-option-content`), ['关闭', '低', '中', '高', '很高 · max'])
  await t.click(`${OPEN_OPTIONS}[title="高"]`, 20)
  t.ok('选中高档', await t.waitUntil(`${levelText}.includes('高')`))

  // —— 发送 → 流式 → 取消 ——
  await t.click('[data-testid="prov-diag-run"]', 20)
  t.ok('发出测活请求（带思考档）', (await t.events()).includes('diagnose:relay/claude-relay:high:stream'))
  t.ok('标题栏显示测试中', await t.waitForText(HEADER, '测试中'))
  t.ok('发送中出现取消按钮', await t.waitFor('[data-testid="prov-diag-cancel"]'))
  t.check('发送中锁住档位', await t.js(`document.querySelector('[data-testid="prov-diag-level"]').closest('.ant-select').classList.contains('ant-select-disabled')`), true)
  await t.act('pushThinking', '用户在问我是谁')
  await t.act('pushText', 'I am')
  t.ok('思考分片单独显示', await t.waitForText('[data-testid="prov-diag-thinking"]', '用户在问我是谁'))
  t.ok('正文分片流式显示', await t.waitForText('[data-testid="prov-diag-output"]', 'I am'))
  await t.shot('running')

  await t.click('[data-testid="prov-diag-cancel"]', 20)
  t.ok('取消发 abort（命中当前请求）', (await t.events()).includes('abort:current'))
  t.ok('标题栏显示已取消', await t.waitForText(HEADER, '已取消'))
  t.ok('取消后回到可发送', await t.waitFor('[data-testid="prov-diag-run"]'))
  t.check('取消保留已收到的正文', await t.text('[data-testid="prov-diag-output"]'), 'I am')
  t.check('取消不显示指标', await t.count('[data-testid="prov-diag-metrics"]'), 0)

  // —— Ctrl+Enter 发送 → 完成 ——
  await t.click('[data-testid="prov-diag-prompt"]', 20)
  await t.key('Enter', ['control'])
  t.ok('Ctrl+Enter 发送', await t.waitFor('[data-testid="prov-diag-cancel"]'))
  await t.act('finish')
  t.ok('完成后标题栏显示成功与总耗时', await t.waitForText(HEADER, '成功 · 1.83 s'))
  t.ok('指标含思考 tokens', ((await t.text('[data-testid="prov-diag-metrics"]')) ?? '').includes('思考 tokens30'))
  t.check('正文换成最终结果', await t.text('[data-testid="prov-diag-output"]'), 'I am Claude.')
  t.check(
    '完成后模型与档位解锁',
    await t.js(`['prov-diag-model', 'prov-diag-level'].map((id) => document.querySelector('[data-testid="' + id + '"]').closest('.ant-select').classList.contains('ant-select-disabled'))`),
    [false, false]
  )
  await t.sleep(300)
  await t.shot('done')

  // —— 分隔条 ——
  const before = await t.rect(BODY)
  const handle = await t.rect('[data-testid="prov-diag-resizer"]')
  const from = { x: handle.x + 200, y: handle.y + 3 }
  await t.drag(from, { x: from.x, y: from.y - 120 })
  t.checkNear('上拖分隔条：测活区变高 120px', (await t.rect(BODY)).h, before.h + 120, 2)
  g = await t.js(geometry)
  t.checkNear('拖高后测活层仍贴底', g.dock.bottom, g.column.bottom, 1)
  await t.drag({ x: from.x, y: from.y - 120 }, { x: from.x, y: 2 })
  g = await t.js(geometry)
  t.info('拖到顶后', g)
  t.ok('拖到顶也给设置层留出高度', g.scroll.h >= 100)

  // —— 收起 / 展开 ——
  await t.click(HEADER, 20)
  t.check('收起后正文消失', await t.count(BODY), 0)
  g = await t.js(geometry)
  t.ok('收起后只剩标题栏', g.dock.h < 50)
  t.checkNear('收起后设置层一直到标题栏', g.scroll.bottom, g.dock.top, 1)
  await t.click(HEADER, 20)
  t.ok('再展开', await t.waitFor(BODY))

  // —— 内置供应商 ——
  await t.click('[data-testid="prov-item-openai"]', 20)
  t.ok('内置供应商也有测活，模型来自已保存的配置', await t.waitUntil(`document.querySelector('${DOCK} .ant-select')?.textContent.includes('gpt-5')`))
  t.check('换供应商清掉上一次结果', await t.count('[data-testid="prov-diag-output"]'), 0)

  await t.setTheme('light')
  await t.sleep(300)
  await t.shot('light')
}
