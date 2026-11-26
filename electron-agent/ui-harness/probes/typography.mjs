import { checkPageHeading } from '../workbenchThemeChecks.mjs'
const q = JSON.stringify
const brand = '[data-testid="titlebar-brand"]'
const tool = 'button[title^="复制工具标识符"]'
const row = '[data-testid="mcp-tool-mcp__antd__antd_list"]'
const description = row + ' > span > span'
const badge = '[data-testid="extension-page-header"] h2 span'
const token = '[title^="按名称、描述、参数定义"]'
const path = '[data-project-path]'
const permission = row + ' .ant-segmented-item-label'
const source = 'button[aria-label="查看或切换配置来源"]'
const css = (t, selector, property) => t.js(`getComputedStyle(document.querySelector(${q(selector)})).getPropertyValue(${q(property)})`)

export default async function typography(t) {
  const cdp = t.win.webContents.debugger
  if (!cdp.isAttached()) cdp.attach()
  await cdp.sendCommand('Network.enable')
  await cdp.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.sendCommand('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  })
  const loaded = new Promise(resolve => t.win.webContents.once('did-finish-load', resolve))
  t.win.webContents.reloadIgnoringCache()
  await loaded
  t.ok('断网且不读缓存，真实 MCP 工具行可见', await t.waitFor(tool))
  await t.js('document.fonts.ready.then(() => true)')
  await cdp.sendCommand('DOM.enable')
  await cdp.sendCommand('CSS.enable')
  const { root } = await cdp.sendCommand('DOM.getDocument')
  async function painted(selector) {
    const { nodeId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
    const { fonts } = await cdp.sendCommand('CSS.getPlatformFontsForNode', { nodeId })
    return fonts.filter(f => f.glyphCount > 0)
  }
  async function localFont(label, selector, name) {
    const fonts = await painted(selector)
    t.info(label, fonts)
    t.ok(label, fonts.some(f => f.isCustomFont && f.familyName.includes(name)))
  }
  await localFont('顶栏实际使用本地 Inter', brand, 'Inter')
  await localFont('antd_list 实际使用本地 JetBrains Mono', tool, 'JetBrains Mono')
  await localFont('英文描述使用 Inter', description, 'Inter')
  await localFont('Token 数值使用 JetBrains Mono', token, 'JetBrains Mono')
  const mixed = await painted(path)
  t.info('项目路径的西文与中文字形', mixed)
  t.ok('混排路径既有本地代码字体也有系统中文字形，无新宋体', mixed.some(f => f.isCustomFont && f.familyName.includes('JetBrains Mono')) &&
    mixed.some(f => !f.isCustomFont) && mixed.every(f => !/simsun|宋体/i.test(f.familyName)))

  t.check('品牌字重', await css(t, brand, 'font-weight'), '600')
  t.checkNear('品牌字距 −0.02em', parseFloat(await css(t, brand, 'letter-spacing')), -0.28, 0.01)
  for (const selector of ['[data-testid="extension-page-header"] h2','[aria-label="最近项目"] h3']) {
    await checkPageHeading(t, selector, selector)
  }
  t.check('项目卡名称使用600字重',await css(t,'[data-project-card] strong','font-weight'),'600')
  t.check('工具名 12.5px', await css(t, tool, 'font-size'), '12.5px')
  t.check('工具名不连字', await css(t, tool, 'font-variant-ligatures'), 'none')
  for (const selector of [permission, source, '[data-testid="mcp-toggle-antd"] + span', '[data-index-badge]']) {
    t.check('小标签字重 ' + selector, await css(t, selector, 'font-weight'), '500')
    t.checkNear('小标签字距 ' + selector, parseFloat(await css(t, selector, 'letter-spacing')),
      0.01 * parseFloat(await css(t, selector, 'font-size')), 0.01)
  }
  for (const selector of [badge, token, '[data-project-metrics] b']) {
    t.check('等宽数字 ' + selector, await css(t, selector, 'font-variant-numeric'), 'tabular-nums')
  }
  t.ok('计数 111 和 888 的实际字宽相等', await t.js(`(() => {
    const s = document.querySelector(${q(badge)}).cloneNode(false)
    document.querySelector(${q(badge)}).parentNode.append(s)
    const width = v => { s.textContent = v; const r = new Range(); r.selectNodeContents(s); return r.getBoundingClientRect().width }
    const equal = width('111') === width('888'); s.remove(); return equal
  })()`))
  t.check('英文副标题行高', await css(t, description, 'line-height'), '18px')
  t.checkColor('暗色副标题对比度', await css(t, description, 'color'), 'rgb(156,163,175)', 1)
  await t.shot('dark')

  await t.click('[data-node-key="connection"]')
  t.ok('切换到真实命令块', await t.waitFor('[data-testid="terminal-command"]'))
  // Shiki paints each syntax token in a leaf span; the enclosing code has no text node of its own.
  for (const selector of ['[data-testid="terminal-command"]', '[data-testid="terminal-output"]', '.pi-md :not(pre) > code', '.pi-md pre code span:not(:has(*)):not(:empty)']) {
    t.ok('显示代码 ' + selector, await t.waitFor(selector))
    await localFont('代码实际字体 ' + selector, selector, 'JetBrains Mono')
    t.check('字符独立 ' + selector, await css(t, selector, 'font-variant-ligatures'), 'none')
  }
  t.ok('关闭 CDN 后数学排版仍有本地样式', await t.waitUntil(`document.querySelector('.katex') && getComputedStyle(document.querySelector('.katex')).fontFamily.includes('KaTeX')`))
  t.ok('工作台没有外网字体样式表', await t.js(`![...document.querySelectorAll('link[rel="stylesheet"]')].some(l => /^https?:/.test(l.href))`))
  await t.shot('commands')
  await t.click('[data-node-key="tools"]')
  await t.setTheme('light')
  t.ok('切回工具列表', await t.waitFor(tool))
  await localFont('浅色主题仍使用本地代码字体', tool, 'JetBrains Mono')
  t.checkColor('浅色描述使用中性次要文字色', await css(t, description, 'color'), 'rgb(113,113,122)', 0)
  await t.shot('light')
}
