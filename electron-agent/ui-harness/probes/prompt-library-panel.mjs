/**
 * 命令页签：列表项是命令胶囊、带参数个数；选中后编辑区填好；改提示词时识别到的参数实时变；与保留名重名时就地报错、保存不可点；
 * 长提示词滚动时背景高亮层跟着 textarea 滚、两层内容宽度一致。
 * 规则页签：开关立即写盘；点规则打开编辑区；窄视口下范围标记不折行；没有工作区时项目范围置灰；浅色主题截图。
 */

const BODY = '[data-testid="prompt-body-input"]'
/** 背景高亮层：textarea 前一个兄弟元素 */
const BACKDROP = `document.querySelector(${JSON.stringify(BODY)}).previousElementSibling`
const TEXTAREA = `document.querySelector(${JSON.stringify(BODY)})`

/** 规则行都在页面下半截，上面的命令编辑区一变高就会被推出视口，点之前先滚到中间 */
async function reveal(t, sel) {
  await t.js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`)
  await t.sleep(150)
}

/** 范围标记（规则行 rowWrap 里最后一个元素）的高度和它自身的行高 */
const badgeMetrics = (key) => `(() => {
  const row = document.querySelector('[data-testid="rule-item-${key}"]')
  let el = row
  while (el.lastElementChild) el = el.lastElementChild
  const s = getComputedStyle(el)
  const lineHeight = s.lineHeight === 'normal' ? parseFloat(s.fontSize) * 1.25 : parseFloat(s.lineHeight)
  return { text: el.textContent, height: el.getBoundingClientRect().height, lineHeight }
})()`

export default async function (t) {
  t.ok('命令列表渲染', await t.waitFor('[data-testid="command-item-refactor"]'))
  t.ok('列表项显示参数个数', (await t.text('[data-testid="command-item-refactor"]')).includes('2 参数'))
  await t.click('[data-testid="command-item-refactor"]', 20)
  t.check('选中后命令名填好', await t.js(`document.querySelector('[data-testid="command-name-input"]').value`), 'refactor')

  await t.click(BODY, 20)
  await t.key('End', ['control'])
  await t.insertText(' 另外 {scope}')
  t.ok('新参数实时识别', await t.waitForText('[data-testid="command-detected-params"]', 'scope'))
  t.ok('占位符在背景层高亮', (await t.count('[data-testid="commands-area"] mark')) >= 3)

  await t.click('[data-testid="command-name-input"]', 20)
  await t.key('a', ['control'])
  await t.type('goal')
  t.ok('与保留名重名就地报错', await t.waitForText('[data-testid="command-error"]', '/goal'))
  t.check('保存按钮不可点', await t.js(`document.querySelector('[data-testid="command-save"]').disabled`), true)
  await t.shot('commands')

  // —— 长提示词：背景层跟着 textarea 滚 ——
  await t.click(BODY, 20)
  await t.key('End', ['control'])
  const lines = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行 {p}`).join('\n')
  await t.insertText(`\n${lines}`)
  t.ok('长提示词写进 textarea', (await t.js(`${TEXTAREA}.value`)).includes('第 40 行 {p}'))
  const overflow = await t.js(`[${TEXTAREA}.scrollHeight, ${TEXTAREA}.clientHeight]`)
  t.info('textarea scrollHeight / clientHeight', overflow)
  t.ok('长提示词让 textarea 出现纵向滚动', overflow[0] > overflow[1] + 100)
  for (let i = 0; i < 6; i++) await t.wheel(BODY, 600)
  t.ok(
    'textarea 滚到底',
    await t.waitUntil(`${TEXTAREA}.scrollTop > 0 && Math.abs(${TEXTAREA}.scrollTop + ${TEXTAREA}.clientHeight - ${TEXTAREA}.scrollHeight) <= 1`)
  )
  await t.sleep(200)
  const scroll = await t.js(`({ textarea: ${TEXTAREA}.scrollTop, backdrop: ${BACKDROP}.scrollTop, backdropMax: ${BACKDROP}.scrollHeight - ${BACKDROP}.clientHeight })`)
  t.info('scrollTop textarea / backdrop / backdrop 最大可滚', scroll)
  t.ok('背景层 scrollTop 与 textarea 一致（差 ≤ 1）', Math.abs(scroll.textarea - scroll.backdrop) <= 1)
  const widths = await t.js(`({ textarea: ${TEXTAREA}.clientWidth, backdrop: ${BACKDROP}.clientWidth, textareaRect: ${TEXTAREA}.getBoundingClientRect().width, backdropRect: ${BACKDROP}.getBoundingClientRect().width })`)
  t.info('clientWidth / rect 宽度 textarea vs backdrop', widths)
  t.check('背景层与 textarea 内容宽度一致（scrollbar-gutter 生效）', widths.backdrop, widths.textarea)
  t.checkNear('背景层与 textarea 外框宽度一致', widths.backdropRect, widths.textareaRect)
  await t.shot('long-prompt')

  // —— 规则 ——
  t.ok('规则列表渲染', await t.waitFor('[data-testid="rule-item-project-pnpm"]'))
  await reveal(t, '[data-testid="rule-toggle-project-pnpm"]')
  await t.click('[data-testid="rule-toggle-project-pnpm"]', 10)
  t.ok('开关立即写盘', (await t.events()).includes('set_context_rule_enabled'))

  await reveal(t, '[data-testid="rule-open-global-zh"]')
  await t.click('[data-testid="rule-open-global-zh"]', 20)
  t.ok('点规则打开编辑区', await t.waitFor('[data-testid="rule-title-input"]'))
  t.check('编辑区名称是「中文回答」', await t.js(`document.querySelector('[data-testid="rule-title-input"]').value`), '中文回答')

  // —— 窄视口：范围标记不折行 ——
  const wide = await t.js(badgeMetrics('global-zh'))
  t.info('宽视口范围标记', wide)
  const before = await t.resize(760, 880)
  await reveal(t, '[data-testid="rule-item-global-zh"]')
  const narrow = await t.js(badgeMetrics('global-zh'))
  t.info('760px 范围标记', narrow)
  t.check('rowWrap 里最后一个元素是范围标记', narrow.text, '全局')
  t.ok('窄视口下范围标记不折行（高度 ≤ 1.5 倍行高）', narrow.height <= narrow.lineHeight * 1.5)
  await t.shot('narrow')
  await t.resize(before[0], before[1])

  await t.act('setWorkspace', '')
  t.ok('切到无工作区后重新加载', await t.waitFor('[data-testid="rule-new"]'))
  await reveal(t, '[data-testid="rule-new"]')
  await t.click('[data-testid="rule-new"]', 20)
  t.check('项目范围置灰', await t.js(`document.querySelector('[data-testid="rule-scope-project"]').getAttribute('aria-disabled')`), 'true')
  await t.shot('rules')

  // —— 浅色主题 ——
  await t.setTheme('light')
  await t.js(`document.querySelector('[data-testid="commands-area"]').scrollIntoView({ block: 'start' })`)
  await t.shot('light')
}
