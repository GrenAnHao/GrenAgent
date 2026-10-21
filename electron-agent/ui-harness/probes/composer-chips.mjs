/**
 * 输入框上方的图片 / 粘贴块：两张图加一个粘贴块后，缩略图 48px、点第一张弹出放大预览（lobehub Image viewer）、
 * 预览里能切到第二张、Esc 关掉；X 仍能移除；
 * 持久化：加完内容后 IndexedDB 里有记录且图片条目没有 url，清空内存再 rehydrate，图片和粘贴块都回来、url 由 data 重建；
 * 内存里已有的桶在 rehydrate 时优先（启动瞬间贴进来的不被存档覆盖）；移除到空后存档里也没有这个 key。
 */

const IMAGE = '[data-testid="chips"] [data-testid="composer-image"]'
const THUMB = `${IMAGE} img`
const VIEWER = '[role="dialog"] img'
const CHIP = '[data-testid="chips"] span[title]'

async function waitStored(t, pred, label) {
  const deadline = Date.now() + 3000
  let stored = null
  while (Date.now() < deadline) {
    stored = await t.act('readStored')
    if (pred(stored)) return stored
    await t.sleep(100)
  }
  t.ok(`${label}：等 IndexedDB 写入超时`, false)
  return stored
}

export default async function (t) {
  const data = await t.data()
  t.ok('场景渲染出来', await t.waitFor('[data-testid="chips"]'))
  await t.act('reset')
  await t.sleep(100)
  t.check('重置后没有缩略图', await t.count(IMAGE), 0)

  // —— 两张图 + 一个粘贴块 ——
  await t.act('addImages')
  await t.act('addChip')
  t.ok('两张缩略图出现', await t.waitFor(IMAGE))
  t.check('缩略图数量', await t.count(IMAGE), 2)
  t.check('粘贴块出现', await t.count(CHIP), 1)
  const thumb = await t.rect(THUMB)
  t.checkNear('缩略图宽 48', thumb.w, 48, 1)
  t.checkNear('缩略图高 48', thumb.h, 48, 1)
  await t.shot('chips')

  // —— 点图放大 ——
  t.check('点开前没有预览层', await t.countVisible(VIEWER), 0)
  await t.click(THUMB, 24)
  t.ok('点第一张弹出放大预览', await t.waitFor(VIEWER))
  await t.sleep(400)
  const big = await t.rect(VIEWER)
  t.ok('预览里的图比缩略图大', big.w > 48 && big.h > 48)
  t.check('预览的是第一张（红）', await t.js(`document.querySelector(${JSON.stringify(VIEWER)}).src`), `data:image/png;base64,${data.red}`)
  await t.shot('preview')
  t.ok('预览里有「1 / 2」计数', (await t.text('[role="dialog"]')).includes('1 / 2'))
  // 下一张：点右侧的箭头按钮（lucide chevron-right）
  const NEXT = '[role="dialog"] [role="button"]:has(.lucide-chevron-right)'
  t.ok('两张图时有「下一张」按钮', await t.waitFor(NEXT))
  await t.click(NEXT, 12)
  await t.waitUntil(`document.querySelector(${JSON.stringify(VIEWER)})?.src === ${JSON.stringify(`data:image/png;base64,${data.blue}`)}`, 2000)
  t.check('→ 切到第二张（蓝）', await t.js(`document.querySelector(${JSON.stringify(VIEWER)}).src`), `data:image/png;base64,${data.blue}`)
  await t.key('Escape')
  await t.sleep(500)
  t.check('Esc 关掉预览', await t.countVisible(VIEWER), 0)

  // —— 落盘形状：有记录、图片没有 url ——
  const stored = await waitStored(t, (s) => typeof s === 'string' && s.includes(data.key), '加完内容后')
  const parsed = stored ? JSON.parse(stored) : null
  const bucket = parsed?.state?.byKey?.[data.key]
  t.check('存档里两张图', bucket?.attachments?.length, 2)
  t.check('存档里图片没有 url', bucket?.attachments?.some((a) => 'url' in a), false)
  t.check('存档里图片带 data', bucket?.attachments?.[0]?.data, data.red)
  t.check('存档里一个粘贴块', bucket?.pastedTexts?.map((p) => p.id), ['pt-fixed'])

  // —— 模拟重启：内存清空、存档不动，再 rehydrate 从 IndexedDB 读回来，url 重建 ——
  await t.act('dropMemoryKeepStorage')
  await t.sleep(100)
  t.check('清空内存后缩略图消失', await t.count(IMAGE), 0)
  await t.act('rehydrate')
  t.ok('rehydrate 后缩略图回来', await t.waitFor(IMAGE))
  t.check('rehydrate 后两张图', await t.count(IMAGE), 2)
  t.check('rehydrate 后粘贴块回来', await t.count(CHIP), 1)
  const snap = await t.act('snapshot')
  t.check('url 由 data 重建', snap.images.map((i) => i.url), [
    `data:image/png;base64,${data.red}`,
    `data:image/png;base64,${data.blue}`,
  ])
  t.check('粘贴块内容不变', snap.chips, [{ id: 'pt-fixed', lines: 3, text: 'line1\nline2\nline3' }])
  await t.shot('rehydrated')

  // —— 内存优先：先清空再加一张，rehydrate 不把它覆盖成存档里的两张 ——
  await t.act('dropMemory')
  await t.act('addChip')
  await t.sleep(100)
  await t.act('rehydrate')
  await t.sleep(200)
  t.check('rehydrate 时内存里已有的桶优先：只有粘贴块、没有图', await t.count(IMAGE), 0)
  t.check('内存里的粘贴块还在', await t.count(CHIP), 1)

  // —— 移除到空：存档里没有这个 key ——
  t.check('此时只有粘贴块的 X 一个按钮', await t.count('[data-testid="chips"] [role="button"]'), 1)
  await t.click('[data-testid="chips"] [role="button"]', 8)
  await t.sleep(100)
  t.check('X 移除粘贴块', await t.count(CHIP), 0)
  await waitStored(t, (s) => typeof s === 'string' && !s.includes(data.key), '移除到空后')
  t.check('移除到空后存档里没有这个 key', (await t.act('readStored'))?.includes(data.key) ?? false, false)
}
