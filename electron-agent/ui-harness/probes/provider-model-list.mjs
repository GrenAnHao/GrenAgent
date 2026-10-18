/**
 * 模型列表拖动排序：只有卡片左侧手柄能拖，拖到第三张下面后顺序变成 beta / gamma / alpha；
 * 从输入框开始拖不排序；键盘（空格拿起、↓ 移动、空格放下）也能排；保存后 models.json 里是新顺序。
 * 价格：缓存读 / 写价两个框；分段计费加一档后整行在卡片宽度内，窄视口也不撑破；保存后落盘带 tiers。
 */

const ids = `[...document.querySelectorAll('[data-testid^="prov-model-id-"]')].map((el) => el.value)`

/** 第 i 张卡片的几何，以及手柄、id 输入框的中心点 */
const cardGeometry = (i) => `(() => {
  const card = document.querySelector('[data-testid="prov-model-card-${i}"]')
  const handle = document.querySelector('[data-testid="prov-model-drag-${i}"]')
  const input = document.querySelector('[data-testid="prov-model-id-${i}"]')
  const c = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } }
  return { card: c(card), handle: c(handle), input: c(input) }
})()`

export default async function (t) {
  t.ok('供应商列表渲染', await t.waitFor('[data-testid="prov-item-relay"]'))
  await t.click('[data-testid="prov-item-relay"]', 20)
  t.ok('三张模型卡片', await t.waitUntil(`${ids}.length === 3`))
  t.check('初始顺序', await t.js(ids), ['alpha', 'beta', 'gamma'])

  // 测活层贴在详情列底部，展开时会盖住列表下半截。默认是收起的，确认一下再把卡片滚到可视区中间。
  t.ok('测活层默认收起', await t.waitUntil(`!document.querySelector('[data-testid="prov-diag-body"]')`))
  await t.js(`document.querySelector('[data-testid="prov-model-card-1"]').scrollIntoView({ block: 'center' })`)
  await t.sleep(200)

  // —— 手柄 ——
  const g0 = await t.js(cardGeometry(0))
  t.info('第一张卡片', g0)
  t.ok('手柄在卡片左侧、id 输入框前面', g0.handle.right <= g0.input.left && g0.handle.left >= g0.card.left)
  t.ok('手柄可被指针命中', await t.hitTest('[data-testid="prov-model-drag-0"]'))
  t.check('手柄是 grab 光标', (await t.style('[data-testid="prov-model-drag-0"]', ['cursor'])).cursor, 'grab')

  // —— 从输入框拖：不排序 ——
  const g2 = await t.js(cardGeometry(2))
  await t.drag({ x: g0.input.x, y: g0.input.y }, { x: g0.input.x, y: g2.card.bottom + 10 }, 12)
  t.check('从输入框开始拖不改顺序', await t.js(ids), ['alpha', 'beta', 'gamma'])

  // —— 拖手柄到第三张下面 ——
  await t.drag({ x: g0.handle.x, y: g0.handle.y }, { x: g0.handle.x, y: g2.card.bottom - 4 }, 16)
  t.ok('拖手柄：alpha 挪到最后', await t.waitUntil(`${ids}.join() === 'beta,gamma,alpha'`))
  t.check('拖完没有残留位移', await t.js(`getComputedStyle(document.querySelector('[data-testid="prov-model-card-2"]').parentElement).transform`), 'none')

  // —— 键盘：空格拿起 beta，↓，空格放下 ——
  await t.js(`document.querySelector('[data-testid="prov-model-drag-0"]').focus()`)
  await t.key('Space')
  await t.key('Down')
  await t.key('Space')
  t.ok('键盘排序：beta 下移一位', await t.waitUntil(`${ids}.join() === 'gamma,beta,alpha'`))
  await t.mouse(g0.handle.x, g0.handle.y)
  await t.shot('handles')
  await t.mouse(2, 2)

  // —— 价格与分段 ——
  // alpha 现在是第三张（index 2），带基础价。
  await t.js(`document.querySelector('[data-testid="prov-model-expand-2"]').scrollIntoView({ block: 'center' })`)
  await t.click('[data-testid="prov-model-expand-2"]', 20)
  t.ok('展开后有缓存读价', await t.waitFor('[data-testid="prov-model-cost-cache-read-2"]'))
  t.ok('有缓存写价', (await t.count('[data-testid="prov-model-cost-cache-write-2"]')) === 1)
  await t.js(`document.querySelector('[data-testid="prov-model-cost-tier-add-2"]').scrollIntoView({ block: 'center' })`)
  await t.click('[data-testid="prov-model-cost-tier-add-2"]', 20)
  t.ok('加了一档分段', await t.waitFor('[data-testid="prov-model-cost-tier-2-0-above"]'))
  t.check('新档默认阈值 100,000', await t.js(`document.querySelector('[data-testid="prov-model-cost-tier-2-0-above"] input, input[data-testid="prov-model-cost-tier-2-0-above"]').value`), '100,000')

  const tierFits = `(() => {
    const card = document.querySelector('[data-testid="prov-model-card-2"]').getBoundingClientRect()
    const remove = document.querySelector('[data-testid="prov-model-cost-tier-2-0-remove"]').getBoundingClientRect()
    const above = document.querySelector('[data-testid="prov-model-cost-tier-2-0-above"]').getBoundingClientRect()
    const cw = document.querySelector('[data-testid="prov-model-cost-tier-2-0-cw"]').getBoundingClientRect()
    return { removeRight: Math.round(remove.right), cardRight: Math.round(card.right), aboveW: Math.round(above.width), cwW: Math.round(cw.width), sameRow: Math.abs(above.top - remove.top) < 4 }
  })()`
  let fit = await t.js(tierFits)
  t.info('分段行', fit)
  t.ok('分段行在卡片里', fit.removeRight <= fit.cardRight)
  t.ok('分段行是一行、输入框不被挤没', fit.sameRow && fit.aboveW >= 60 && fit.cwW >= 40)
  await t.shot('tiers')

  const before = await t.resize(1000, 880)
  fit = await t.js(tierFits)
  t.info('窄视口分段行', fit)
  t.ok('窄视口：分段行仍在卡片里', fit.removeRight <= fit.cardRight)
  await t.resize(before[0], before[1])

  // —— 保存 ——
  await t.click('[data-testid="prov-save"]', 20)
  t.ok('保存写盘', await t.waitUntil(`(window.__uiEvents ?? []).includes('save')`))
  const savedDoc = JSON.parse((await t.data()).savedModelsJson)
  t.check('保存：models.json 带 pi 发布的 $schema', savedDoc.$schema, 'https://pi.dev/schemas/models.schema.json')
  const saved = savedDoc.providers.relay.models
  t.check('落盘顺序跟着拖动', saved.map((m) => m.id), ['gamma', 'beta', 'alpha'])
  t.check('落盘带分段（四价抄基础价）', saved[2].cost, {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 100000, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  })

  await t.setTheme('light')
  await t.shot('light')
}
