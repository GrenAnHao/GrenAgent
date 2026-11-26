import { checkPageHeading, compareThemeGeometry } from '../workbenchThemeChecks.mjs'
const id = (name) => `[data-testid="${name}"]`
const body = id('prompt-body-input')

async function replace(t, selector, value) {
  await t.click(selector, 20)
  await t.key('a', ['control'])
  await t.insertText(value)
}

async function reveal(t, selector) {
  await t.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'nearest' })`)
  await t.sleep(120)
}

async function clickMenuText(t, text) {
  const point = await t.js(`(() => {
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(el => el.checkVisibility() && el.textContent.includes(${JSON.stringify(text)}))
    if (!item) return null
    const r = item.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  t.ok(`导入菜单有「${text}」入口`, Boolean(point))
  if (point) await t.click(point)
}

async function checkBounds(t, label) {
  const bounds = await t.js(`(() => {
    const root = document.querySelector('[data-testid="extensions-panel"]')
    const r = root.getBoundingClientRect()
    const controls = [...root.querySelectorAll('button, input, textarea, [role="switch"]')]
      .filter(el => el.checkVisibility() && !el.closest('[aria-hidden="true"]'))
      .map(el => ({ id: el.getAttribute('data-testid') ?? el.tagName, r: el.getBoundingClientRect() }))
      .filter(({ r: c }) => c.width > 0 && c.height > 0 && c.top < r.bottom && c.bottom > r.top)
    return {
      width: r.width, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
      outside: controls.filter(({ r: c }) => c.left < r.left - 2 || c.right > r.right + 2).map(({ id }) => id),
      pageScroll: document.documentElement.scrollWidth > innerWidth + 1,
    }
  })()`)
  t.info(`${label} 面板几何`, bounds)
  t.ok(`${label} 页面没有横向溢出`, !bounds.pageScroll && bounds.scrollWidth <= bounds.clientWidth + 1)
  t.check(`${label} 可见控件保持在模块内`, bounds.outside, [])
}

async function checkDraftResize(t, page, item, list, editor, back, suffix) {
  const input = page === 'rules' ? id('rule-body-input') : body
  await t.resize(1420, 880)
  await t.click(id(`ext-tab-${page}`))
  t.ok(`${page} 目录加载`, await t.waitFor(id(item)))
  await t.click(id(item), 20)
  if (page === 'rules') await t.click(id('rule-edit'))
  await t.click(input, 20)
  await t.key('End', ['control'])
  await t.insertText(suffix)
  const expected = await t.js(`document.querySelector(${JSON.stringify(input)}).value`)
  await t.js(`window.__extensionDraftNode = document.querySelector(${JSON.stringify(input)})`)
  for (const width of [920, 760, 520, 1420]) {
    await t.resize(width, 880)
    await t.sleep(100)
    t.check(`${page} ${width}px 未保存正文保留`, await t.js(`document.querySelector(${JSON.stringify(input)}).value`), expected)
    t.check(`${page} ${width}px 编辑器没有重挂载`, await t.js(`document.querySelector(${JSON.stringify(input)}) === window.__extensionDraftNode`), true)
    await checkBounds(t, `${page} ${width}px`)
    if (width === 520) {
      t.check(`${page} 窄列隐藏目录`, await t.countVisible(id(list)), 0)
      t.check(`${page} 窄列显示详情`, await t.countVisible(id(editor)), 1)
      await t.click(id(back))
      t.check(`${page} 返回后目录可见`, await t.countVisible(id(list)), 1)
      t.check(`${page} 返回目录没有丢草稿`, await t.js(`window.__extensionDraftNode.value`), expected)
      await t.click(id(item), 20)
      t.check(`${page} 重新打开保留草稿`, await t.js(`document.querySelector(${JSON.stringify(input)}).value`), expected)
    }
  }
}

async function mcpFrame(t, label) {
  const geometry = await t.js(`(() => {
    const body = document.querySelector('${id('extensions-body')}')
    const frame = document.querySelector('${id('mcp-workbench')}')
    const b = body.getBoundingClientRect(), r = frame.getBoundingClientRect(), style = getComputedStyle(body)
    return { frame: { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right },
      limit: b.bottom - parseFloat(style.paddingBottom), leftLimit: b.left + parseFloat(style.paddingLeft), rightLimit: b.right - parseFloat(style.paddingRight), topLimit: b.top + parseFloat(style.paddingTop),
      scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, outerScroll: body.scrollTop }
  })()`)
  t.info(`${label} MCP纵向几何`, geometry)
  t.ok(`${label} MCP外框完整留在外层留白以内`, geometry.frame.bottom <= geometry.limit + 1 && geometry.frame.x >= geometry.leftLimit - 1 && geometry.frame.right <= geometry.rightLimit + 1 && geometry.frame.y >= geometry.topLimit - 1)
  t.ok(`${label} MCP外层不被内容撑高`, geometry.scrollHeight <= geometry.clientHeight + 1)
  return geometry
}

const toolRows = `${id('mcp-detail')} [data-testid^="mcp-tool-mcp__"]`

const connectionTab = '[role="tab"][id$="-tab-connection"]'
const toolsTab = '[role="tab"][id$="-tab-tools"]'

const white = 'rgb(255, 255, 255)'
const border = 'rgba(0, 0, 0, 0.08)'
const ink = 'rgb(24, 24, 27)', primary = 'rgb(74, 107, 78)'
const sage = 'rgba(92, 128, 96, 0.1)', sageLine = 'rgba(92, 128, 96, 0.28)'
const sidebar = 'rgb(244, 245, 243)', canvas = 'rgb(248, 249, 248)'
const longServer = 'company-internal-design-system-and-production-observability-mcp-server-with-a-very-long-installation-name'

async function checkLongServer(t, label) {
  const x = await t.js(`(() => {
    const row = document.querySelector('${id('mcp-select-'+longServer)}'), name = row.querySelector('span:last-child > span:first-child'),
      simple = document.querySelector('${id('mcp-select-antd')} > span:last-child > span:first-child'),
      style = getComputedStyle(name)
    return { text:name.textContent, title:name.title || row.title, wrap:style.whiteSpace, overflow:style.overflowX, cut:style.textOverflow,
      clipped:name.scrollWidth > name.clientWidth, sameHeight:name.getBoundingClientRect().height === simple.getBoundingClientRect().height }
  })()`)
  t.check(label+' 超长服务名只占一行、省略显示，完整名称仍可读', x,
    {text:longServer,title:longServer,wrap:'nowrap',overflow:'hidden',cut:'ellipsis',clipped:true,sameHeight:true})
}

async function checkScrollbar(t, mode) {
  const s = await t.js(`(() => {
    const el = document.querySelector('${id('mcp-directory')}'), p = name => getComputedStyle(el,'::-webkit-scrollbar'+name), r = el.getBoundingClientRect()
    return {width:p('').width,height:p('').height,track:p('-track').backgroundColor,thumb:p('-thumb').backgroundColor,
      x:Math.floor(r.left+el.clientLeft+el.clientWidth+2), y:Math.floor(r.top+Math.min(40, el.clientHeight*el.clientHeight/el.scrollHeight/2)),
      surface:getComputedStyle(el).backgroundColor, actual:el.scrollHeight > el.clientHeight}
  })()`)
  t.check(mode+' 真实目录滚动条宽高 6px 且轨道全透明', [s.width,s.height,s.track,s.actual], ['6px','6px','rgba(0, 0, 0, 0)',true])
  const channel = mode === 'dark' ? 255 : 0, alpha = mode === 'dark' ? 0.12 : 0.14
  t.checkColor(mode+' 滚动条拇指默认颜色', s.thumb, `rgba(${channel}, ${channel}, ${channel}, ${alpha})`, 0)
  const sample = async () => {
    // 1 DIP crop, downsample to one BGRA pixel even on high-density monitors.
    const image = (await t.win.webContents.capturePage({x:s.x,y:s.y,width:1,height:1})).resize({width:1,height:1}), p=image.toBitmap()
    return [p[2],p[1],p[0]]
  }
  const base=s.surface.match(/\d+/g).slice(0,3).map(Number), expected = opacity => base.map(v=>Math.round((1-opacity)*v+opacity*channel))
  const before = await sample()
  await t.mouse(s.x,s.y)
  const hovered = await sample()
  t.info(mode+' 滚动条实绘像素（默认/悬停）', {x:s.x,y:s.y,before,hovered,surface:s.surface})
  t.ok(mode+' 拇指真实悬停后为 25% 强度', [before,hovered].every((rgb,i) => rgb.every((v,j)=>Math.abs(v-expected(i?0.25:alpha)[j])<=2)))
  await t.hover(id('extension-page-header')+' h2')
}

async function checkDenseControl(t,label,selector) {
  const size = await t.style(selector+' .ant-segmented-item-label',['font-size'])
  t.check(label+' 字号 12px',size?.fontSize,'12px')
  const {height} = await t.js(`document.querySelector('${selector}').getBoundingClientRect().toJSON()`)
  t.ok(label+' 高度 24～26px', height >=24 && height <=26)
}

async function checkMcpTheme(t) {
  const title = id('extension-page-header')+' h2', frame = id('mcp-workbench'), master = id('mcp-directory'), detail = id('mcp-detail')
  const server = id('mcp-server-antd'), selected = master+' [data-selected="true"]', nav=id('ext-tab-mcp'), rail=id('module-extensions')
  const cardIcon = server+' span:has(> svg.lucide-server)', detailName = cardIcon+' + div > span:first-child'
  const name = id('mcp-select-antd')+' > span:last-child > span:first-child', status = id('mcp-status-antd')
  const meta = server+' span:has(> button[aria-label="查看或切换配置来源"])'
  const toolName = id('mcp-tool-mcp__antd__antd_list')+' button[title^="复制工具标识符"]', description=toolName+' + span'
  const toggle=id('mcp-toggle-antd'), add=id('mcp-add'), bulk=id('mcp-bulk-settings'), remove=id('mcp-delete-antd'), search='input[aria-label="搜索服务器"]'
  const filter=id('mcp-permission-filter'), permission=id('mcp-perm-mcp__antd__antd_list')
  const firstLightPaint = [[name,'color',ink],[detailName,'color',ink],[rail+' svg','stroke',primary],[cardIcon+' svg','stroke',primary]]
  await t.act('showChrome', true)
  await t.waitFor('[data-testid="titlebar-brand"]')
  await t.hover(title)
  for (const mode of ['dark','light']) {
    await t.setTheme(mode)
    await t.js('document.fonts.ready.then(()=>true)')
    await compareThemeGeometry(t,'MCP 工作台','#root',mode==='dark'?'before':'after',firstLightPaint)
    if (mode==='light') {
      const r=await t.rect(name), image=await t.win.webContents.capturePage({
        x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.w),height:Math.floor(r.h),
      })
      const bgra=image.toBitmap()
      let glyphPixels=0
      for (let i=0;i<bgra.length;i+=4) if (Math.max(bgra[i],bgra[i+1],bgra[i+2])<70) glyphPixels++
      t.ok('浅色选中服务名实际画出深色字形，不只是 DOM 计算色正确',glyphPixels>5)
    }
    await t.shot('theme-antd-'+mode)
    await checkPageHeading(t,mode+' MCP',title)
    t.check(mode+' 常规操作为 filled，主操作为 solid',
      await t.js(`[document.querySelector('${id('mcp-refresh')}').classList.contains('ant-btn-variant-filled'),
        document.querySelector('${add}').classList.contains('ant-btn-variant-solid')]`), [true,true])
    for (const [sel,px] of [[title+' span',11],[detailName,16],[meta,11],[nav,13],[name,13],[add,13],[id('mcp-refresh'),13],
        [toolsTab,13],[search,13],['input[aria-label="搜索工具名或描述"]',13],[status,12],[description,12],[id('mcp-global-budget'),12],
        [bulk,12],[toolName,12.5]]) {
      t.check(mode+' 字号 '+sel,(await t.style(sel,['font-size']))?.fontSize,px+'px')
    }
    t.check(mode+' 详情标题字重',(await t.style(detailName,['font-weight']))?.fontWeight,'600')
    t.check(mode+' 标签内边距',(await t.style(meta,['padding']))?.padding,'2px 6px')
    t.check(mode+' 工具函数名 500',(await t.style(toolName,['font-weight']))?.fontWeight,'500')
    t.ok(mode+' 工具函数名为本地等宽字族',(await t.style(toolName,['font-family']))?.fontFamily.includes('JetBrains Mono'))
    await checkLongServer(t,mode+' 宽目录')
    await checkDenseControl(t,mode+' 权限筛选',filter)
    await checkDenseControl(t,mode+' 逐工具权限',permission)
    await checkScrollbar(t,mode)
  }
  const titlebar = '[data-tauri-drag-region]:has(> [data-tauri-drag-region])'
  for (const [sel,prop,color] of [[titlebar,'background-color','rgb(236, 238, 235)'],[id('module-rail'),'background-color','rgb(236, 238, 235)'],
    ['nav[aria-label="扩展页面"]','background-color',sidebar],[id('extension-stage'),'background-color',canvas],[master,'background-color',sidebar],
    [detail,'background-color',white],[frame,'border-top-color',border],[master,'border-right-color',border],[toolsTab,'color',primary],
    [detail+' .ant-tabs-ink-bar','background-color',primary],[add,'background-color',primary],[toggle,'background-color',primary],[remove,'color','rgb(220, 38, 38)']]) {
    t.checkColor(sel+' '+prop, await t.js(`getComputedStyle(document.querySelector('${sel}')).getPropertyValue('${prop}')`),color,0)
  }
  for (const sel of [rail,nav,selected,cardIcon]) {
    const css = await t.style(sel,['background-color','border-top-color','border-top-width','box-shadow'])
    t.checkColor(sel+' 半透明 Sage 填充',css?.backgroundColor,sage,0)
    t.checkColor(sel+' 柔和 Sage 边线',css?.borderTopColor,sageLine,0)
    t.ok(sel+' 边框实际可见',parseFloat(css?.borderTopWidth)>0)
    t.ok(sel+' 无悬浮白卡阴影',css?.boxShadow==='none'||css?.boxShadow.endsWith('inset'))
  }
  t.check('主按钮前景是白色', await t.js(`(()=>{const c=document.createElement('canvas').getContext('2d'); c.fillStyle=getComputedStyle(document.querySelector('${add}')).color; c.fillRect(0,0,1,1); return Array.from(c.getImageData(0,0,1,1).data)})()`),[255,255,255,255])
  await t.click(filter+' .ant-segmented-item:nth-child(2)')
  t.check('筛选切换至自动',(await t.text(filter+' .ant-segmented-item-selected'))?.trim(),'自动 (8)')
  await t.click(filter+' .ant-segmented-item:first-child')
  await t.click(search,20)
  t.ok('搜索接收真实焦点', await t.js(`document.activeElement===document.querySelector('${search}')`))
  await t.shot('theme-antd-search-focused-light')
  await t.click(title)
  await t.setTheme('dark')
  await t.act('showChrome',false)
}

async function checkToolFilterAndBulk(t) {
  t.ok('长工具夹具默认选中 js-reverse-mcp', await t.waitUntil(`document.querySelector('${id('mcp-select-js-reverse-mcp')}')?.getAttribute('aria-pressed') === 'true'`))
  t.ok('工具多时出现筛选框', await t.waitFor(id('mcp-tool-filter-js-reverse-mcp')))
  t.check('筛选前列出全部 81 个工具', await t.count(toolRows), 81)
  await t.click(`${id('mcp-permission-filter')} .ant-segmented-item:last-child`)
  t.check('按当前禁用权限只列出一个工具', await t.count(toolRows), 1)
  await t.click(`${id('mcp-permission-filter')} .ant-segmented-item:first-child`)
  await replace(t, id('mcp-tool-filter-js-reverse-mcp'), '最后一页')
  t.ok('按描述筛选到最后一项', await t.waitUntil(`document.querySelectorAll('${toolRows}').length === 1 && !!document.querySelector('${id('mcp-tool-mcp__js-reverse-mcp__tool_80')}')`))
  await t.click(connectionTab)
  await t.click(toolsTab)
  t.check('同一服务切回工具标签保留搜索', await t.js(`document.querySelector('${id('mcp-tool-filter-js-reverse-mcp')}').value`), '最后一页')
  await t.click(id('mcp-select-beta'))
  await t.click(connectionTab)
  t.ok('普通请求头展示可读值', await t.waitForText(id('mcp-detail'), 'application/json'))
  t.ok('默认 DOM 无明文令牌', !(await t.text(id('mcp-detail'))).includes('Bearer fixture-only'))
  await t.click('button[aria-label="显示 Authorization"]')
  t.ok('主动揭示单一凭据', await t.waitForText(id('mcp-detail'), 'Bearer fixture-only'))
  await t.click(id('mcp-select-js-reverse-mcp'))
  t.check('返回原服务器不保留工具搜索', await t.js(`document.querySelector('${id('mcp-tool-filter-js-reverse-mcp')}').value`), '')
  await t.click(id('mcp-select-beta'))
  await t.click(connectionTab)
  t.ok('切换服务器后凭据恢复遮罩', !(await t.text(id('mcp-detail'))).includes('Bearer fixture-only'))
  await t.click(id('mcp-select-js-reverse-mcp'))
  await t.js(`document.querySelector('button[aria-label="tool_80 参数与调试"]').scrollIntoView({block:'center'})`)
  await t.click('button[aria-label="tool_80 参数与调试"]')
  t.ok('参数定义来自服务器', await t.waitForText('.ant-modal', 'properties'))
  await t.click('.ant-modal .ant-btn-primary')
  t.ok('单工具测试显示调用结果', await t.waitForText('.ant-modal', 'fixture result'))
  await t.key('Escape')
  const fps = await t.scrollFps(id('mcp-tool-list-js-reverse-mcp'), 1200, 24)
  t.info('81 工具局部滚动采样（fps）', fps)
  t.ok('81 工具列表持续产生滚动帧', fps >= 24)
  await replace(t, id('mcp-tool-filter-js-reverse-mcp'), 'tool_3')
  t.ok('筛选只留短名命中的 11 个工具', await t.waitUntil(`document.querySelectorAll('${toolRows}').length === 11`))
  await t.click(id('mcp-tool-filter-js-reverse-mcp'), 20)
  await t.key('a', ['control'])
  await t.key('Backspace')
  t.ok('清空筛选后工具全部回来', await t.waitUntil(`document.querySelectorAll('${toolRows}').length === 81`))
  await replace(t, id('mcp-tool-filter-js-reverse-mcp'), 'tool_80')
  t.ok('按搜索结果更新权限筛选计数', await t.waitForText(id('mcp-permission-filter'), '全部 (1)'))
  const writeCount = () => t.act('snapshot').then(s => s.calls.filter(c => c.command === 'write_mcp_policy').length)
  const beforeWrite = await writeCount()
  await t.click(id('mcp-bulk-settings'))
  await t.click(id('mcp-perm-all-disabled'))
  t.ok('确认明确包括不在搜索结果的全部工具', await t.waitForText('.ant-modal', '81 个工具'))
  await t.key('Escape')
  t.check('取消覆盖不写策略', await writeCount(), beforeWrite)
  await t.click(id('mcp-bulk-settings'))
  await t.click(id('mcp-perm-all-disabled'))
  await t.click('.ant-modal .ant-btn-primary')
  t.ok('屏幕确认整组权限已保存', await t.waitForText('.ant-message', '已更新 81 个工具的权限'))
  await replace(t, id('mcp-tool-filter-js-reverse-mcp'), '')
  t.ok('批量保存后禁用计数为 81', await t.waitForText(id('mcp-permission-filter'), '禁用 (81)'))
  const snapshot = await t.act('snapshot')
  t.check('全部设为一次写入首尾工具', ['mcp__js-reverse-mcp__tool_1', 'mcp__js-reverse-mcp__tool_80'].map((name) => snapshot.policy.tools?.[name]?.permission), ['disabled', 'disabled'])
  t.check('全部设为保留其他服务器的权限', snapshot.policy.tools?.mcp__beta__search?.permission, 'needs_approval')
}

async function checkCrowdedMcp(t) {
  await t.act('setCrowdedMcp', true)
  t.ok('长目录载入最后一台服务器', await t.waitFor(id('mcp-select-extra-20')))
  await t.click(id('mcp-select-antd'))
  t.ok('8 个 antd 工具均为自动', await t.waitForText(id('mcp-permission-filter'), '自动 (8)'))
  t.ok('全局汇总计入未选中的目录与直接暴露工具', await t.waitForText(id('mcp-global-budget'), '预估常驻开销 ≈ 200 tokens'))
  t.ok('81 与 51 工具的服务均有侧栏体积标记', await t.count('[aria-label^="高开销，"]') === 2)
  const visibleTooltip = text => t.waitUntil(`[...document.querySelectorAll('[role="tooltip"]')].some(el => el.checkVisibility() && el.textContent.includes(${JSON.stringify(text)}))`)
  const antdRow = id('mcp-tool-mcp__antd__antd_list')
  await checkMcpTheme(t)
  await t.hover(antdRow+' span[class] > span')
  t.ok('截断的英文描述可悬停阅读全文', await visibleTooltip('usage examples, and supported properties.'))
  await t.hover(antdRow+' button[aria-label$="参数规则"]')
  t.ok('滑块说明参数审批规则', await visibleTooltip('编辑此工具的参数审批规则'))
  await t.hover(antdRow+' button[aria-label$="参数与调试"]')
  t.ok('花括号说明参数预览和调用', await visibleTooltip('查看参数定义并测试调用'))
  await t.click(id('mcp-tool-mcp__antd__antd_list')+' button[title^="复制工具标识符"]')
  t.ok('复制规则所用的注册全名', (await t.act('snapshot')).copied === 'mcp__antd__antd_list')
  t.ok('复制有明确反馈', await t.waitForText('.ant-message','已复制工具名'))
  await t.click(id('mcp-select-deepwiki'))
  t.ok('远程慢连接显示实际耗时', await t.waitForText(id('mcp-slow-handshake'),'连接已耗时'))
  await t.click(id('mcp-slow-handshake')+' .ant-btn-link')
  t.ok('实时日志展示远程握手阶段', await t.waitForText('.ant-modal','等待服务器响应初始化握手'))
  await t.key('Escape')
  await t.click(id('mcp-slow-handshake')+' button:last-of-type')
  t.ok('只终止当前尝试并保留已启用配置', await t.waitForText(id('mcp-status-deepwiki'),'已终止连接'))
  await t.click(id('mcp-select-js-reverse-mcp'))
  t.ok('混合权限计数与已保存策略一致', await t.waitForText(id('mcp-permission-filter'), '自动 (80)'))
  await t.waitUntil("!document.querySelector('.ant-message-notice')")
  await t.shot('mcp-refined-81-dark')
  await checkToolFilterAndBulk(t)
  for (const size of [[1420, 880], [1420, 430], [520, 430]]) {
    const [width, height] = size, label = `${width}×${height}`
    await t.resize(width, height)
    await t.sleep(100)
    await mcpFrame(t, label)
    if (width > 680) {
      const ranges = await t.js(`(() => {
        const directory = document.querySelector('${id('mcp-directory')}'), detail = document.querySelector('${id('mcp-detail')}')
        const tools = document.querySelector('${id('mcp-tool-list-js-reverse-mcp')}')
        const pane = tools.parentElement
        return { directory: directory.scrollHeight - directory.clientHeight, detail: detail.scrollHeight - detail.clientHeight, tools: tools.scrollHeight - tools.clientHeight, pane: pane.scrollHeight - pane.clientHeight }
      })()`)
      t.info(`${label} 滚动范围`, ranges)
      t.ok(`${label} 目录有独立滚动范围`, ranges.directory > 0)
      t.ok(`${label} 工具区只有一个滚动容器`, height >= 880 ? ranges.tools > 0 && ranges.pane <= 1 : ranges.pane > 0 && ranges.tools <= 1)
      if (height >= 880) t.ok('长列表利用详情剩余高度', (await t.rect(id('mcp-tool-list-js-reverse-mcp'))).h > 360)
      if (height >= 880) t.ok(`${label} 详情栏本身不滚动`, ranges.detail <= 1)
    }
  }
  await t.resize(1420, 880)
  await t.js(`document.querySelector('${id('mcp-directory')}').scrollTop = 0; document.querySelector('${id('mcp-tool-list-js-reverse-mcp')}').scrollTop = 0`)
  const before = await mcpFrame(t, '滚动前')
  const configRect = () => t.js(`(() => { const r = document.querySelector('${connectionTab}').getBoundingClientRect(), d = document.querySelector('${id('mcp-detail')}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, gap: d.bottom - r.bottom, inside: r.top >= d.top && r.bottom <= d.bottom } })()`)
  const configBefore = await configRect()
  t.info('连接配置位置', configBefore)
  t.ok('连接配置标签在当前视口可点击', configBefore.inside)
  await t.wheel(id('mcp-directory'), 500)
  const scrolls = () => t.js(`({ directory: document.querySelector('${id('mcp-directory')}').scrollTop, detail: document.querySelector('${id('mcp-detail')}').scrollTop, tools: document.querySelector('${id('mcp-tool-list-js-reverse-mcp')}').scrollTop, outer: document.querySelector('${id('extensions-body')}').scrollTop })`)
  const afterDirectory = await scrolls()
  t.ok('真实滚轮使服务器目录内部滚动', afterDirectory.directory > 0)
  t.check('目录滚动不带动工具列表', afterDirectory.tools, 0)
  t.check('目录滚动不带动外层', afterDirectory.outer, 0)
  await t.wheel(id('mcp-tool-list-js-reverse-mcp'), 500)
  const afterTools = await scrolls()
  t.ok('真实滚轮只滚工具列表', afterTools.tools > 0)
  t.check('工具列表滚动不带动详情栏', afterTools.detail, 0)
  t.checkNear('工具列表滚动不带动目录', afterTools.directory, afterDirectory.directory, 1)
  t.check('工具列表滚动不带动外层', afterTools.outer, 0)
  await t.wheel(id('mcp-directory'), 10000)
  await t.wheel(id('mcp-tool-list-js-reverse-mcp'), 10000)
  const configAfter = await configRect()
  t.checkNear('滚到工具末尾时连接配置原地不动', configAfter.top, configBefore.top, 1)
  const reachable = await t.js(`(() => {
    const directory = document.querySelector('${id('mcp-directory')}').getBoundingClientRect()
    const list = document.querySelector('${id('mcp-tool-list-js-reverse-mcp')}').getBoundingClientRect()
    const lastServer = document.querySelector('${id('mcp-select-extra-20')}').getBoundingClientRect()
    const lastTool = document.querySelector('${id('mcp-tool-mcp__js-reverse-mcp__tool_80')}').getBoundingClientRect()
    return { lastServer: lastServer.top >= directory.top && lastServer.bottom <= directory.bottom, lastTool: lastTool.top >= list.top && lastTool.bottom <= list.bottom + 1 }
  })()`)
  t.ok('目录底部的服务器可到达', reachable.lastServer)
  t.ok('工具列表末项可到达', reachable.lastTool)
  const tail = await t.js(`(() => {
    const list = document.querySelector('${id('mcp-tool-list-js-reverse-mcp')}'), last = list.lastElementChild;
    return { separator: getComputedStyle(last.previousElementSibling).borderBottomWidth,
      last: getComputedStyle(last).borderBottomWidth, padding: getComputedStyle(list).paddingBottom,
      gap: list.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom };
  })()`)
  t.ok('只去掉最后一行的分隔线', parseFloat(tail.separator) > 0 && tail.last === '0px')
  t.check('滚动容器的底部内边距', tail.padding, '8px')
  t.checkNear('滚到底后保留 8px 空隙', tail.gap, 8, 1)
  const after = await mcpFrame(t, '滚动后')
  t.checkNear('内部滚动后外框顶边不移动', after.frame.y, before.frame.y, 1)
  t.checkNear('内部滚动后外框高度不变', after.frame.height, before.frame.height, 1)
  await t.shot('mcp-crowded-bounded')
  await t.wheel(id('mcp-directory'), -10000)
  await t.wheel(id('mcp-tool-list-js-reverse-mcp'), -10000)
  await t.click(id('extension-page-header') + ' h2')
  await t.setTheme('light')
  t.checkColor('重复切回浅色恢复 Sage 主按钮',(await t.style(id('mcp-add'),['background-color']))?.backgroundColor,primary,0)
  await t.shot('mcp-contained-wide-light')
  await t.resize(520, 430)
  if (await t.countVisible(id('mcp-back'))) await t.click(id('mcp-back'))
  await mcpFrame(t, '窄短窗目录')
  await checkLongServer(t, '窄目录')
  await t.wheel(id('mcp-directory'), 500)
  t.ok('窄短窗服务器目录内部可滚动', await t.js(`document.querySelector('${id('mcp-directory')}').scrollTop > 0`))
  await t.wheel(id('mcp-directory'), -10000)
  await t.click(id('mcp-select-js-reverse-mcp'), 20)
  await mcpFrame(t, '窄短窗详情')
  const tabBounds = await t.rect(connectionTab), narrowBounds = await t.rect(id('mcp-detail'))
  t.ok('窄短窗进入详情无需滚动即可选择配置', tabBounds.y >= narrowBounds.y && tabBounds.bottom <= narrowBounds.bottom)
  t.check('窄短窗仅显示详情', await t.countVisible(id('mcp-directory')), 0)
  await t.wheel(id('mcp-tool-pane-js-reverse-mcp'), 10000)
  const narrowEnd = await t.js(`(() => {
    const detail = document.querySelector('${id('mcp-detail')}'), r = detail.getBoundingClientRect()
    const summary = detail.querySelector('${connectionTab}').getBoundingClientRect()
    const tools = document.querySelector('${id('mcp-tool-pane-js-reverse-mcp')}')
    const end = tools.querySelector('[data-testid="mcp-tool-mcp__js-reverse-mcp__tool_80"]').getBoundingClientRect()
    return { lastVisible: end.bottom <= tools.getBoundingClientRect().bottom + 1 && end.top >= tools.getBoundingClientRect().top, scroll: detail.scrollTop, tools: tools.scrollTop, toolsHeight: tools.clientHeight, reached: summary.top >= r.top && summary.bottom <= r.bottom, outer: document.querySelector('${id('extensions-body')}').scrollTop }
  })()`)
  t.info('窄短窗详情滚动', narrowEnd)
  t.check('工具滚到底不带走服务器标题和操作', narrowEnd.scroll, 0)
  t.ok('窄短窗工具列表保持可滚动阅读区', narrowEnd.toolsHeight >= 89 && narrowEnd.tools > 0 && narrowEnd.lastVisible && narrowEnd.reached)
  await t.click(connectionTab)
  t.ok('窄短窗从列表末项一键查看配置', await t.waitForText(id('mcp-detail'), '启动命令'))
  await t.click(toolsTab)
  t.check('窄短窗外层仍不滚动', narrowEnd.outer, 0)
  await t.wheel(id('mcp-tool-pane-js-reverse-mcp'), -10000)
  await t.wheel(id('mcp-detail'), -10000)
  await t.shot('mcp-contained-narrow-light')
  await t.click(id('mcp-back'))
  t.check('窄短窗可返回目录', await t.countVisible(id('mcp-directory')), 1)
  await t.setTheme('dark')
  await t.act('setCrowdedMcp', false)
  await t.resize(1420, 880)
  await t.waitFor(id('mcp-select-alpha'))
}

async function checkSkillGrid(t, label) {
  const gridFit = await t.js(`(() => {
    const cards = [...document.querySelectorAll('${id('skill-catalog')} > [data-testid^="skill-"]')]
    const spill = cards.filter((card) => {
      const r = card.getBoundingClientRect()
      return [...card.querySelectorAll('*')].some((el) => { const c = el.getBoundingClientRect(); return c.height > 0 && (c.bottom > r.bottom + 1 || c.top < r.top - 1) })
    }).map((card) => card.dataset.testid)
    const rects = cards.map((card) => card.getBoundingClientRect())
    const overlap = rects.some((a, i) => rects.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom - 1 && b.top < a.bottom - 1))
    return { spill, overlap }
  })()`)
  t.info(`${label} 网格卡片`, gridFit)
  t.check(`${label} 网格卡片内容都在卡片框里`, gridFit.spill, [])
  t.check(`${label} 网格卡片互不重叠`, gridFit.overlap, false)
}

export async function checkMcpManagement(t) {
  const data = await t.data()
  t.ok('真实扩展模块加载', await t.waitFor(id('mcp-select-alpha')))
  const resident = id('mcp-global-budget')+' [tabindex="0"]'
  t.ok('目录定义合计非零', await t.waitUntil(`/定义合计 ≈ [1-9]/.test(document.querySelector('${id('mcp-global-budget')}')?.textContent ?? '')`))
  t.ok('按需工具不会算作常驻定义', await t.waitForText(resident, '≈ 0 tokens'))
  await t.hover(resident)
  t.ok('悬停常驻开销解释零值', await t.waitUntil(`[...document.querySelectorAll('[role="tooltip"]')].some(el => el.checkVisibility() && el.textContent.includes('codemode 模式下工具定义按需检索调用，不常驻占用会话初始 System Prompt 前缀'))`))
  await checkCrowdedMcp(t)
  const navMcp = await t.rect(id('ext-tab-mcp'))
  const navSkills = await t.rect(id('ext-tab-skills'))
  const workbench = await t.rect(id('mcp-workbench'))
  t.ok('宽模块使用纵向导航', navSkills.y > navMcp.y && Math.abs(navSkills.x - navMcp.x) <= 1)
  t.ok('宽模块导航与工作台并列', workbench.x > navMcp.right)
  await checkBounds(t, 'MCP 1420px')
  t.ok('缓存工具不掩盖真实连接失败', (await t.text(id('mcp-select-alpha'))).includes('连接失败'))
  t.ok('诊断卡展示最近握手错误', await t.waitForText('[aria-label="错误诊断"]', 'ECONNREFUSED 127.0.0.1:4010'))
  await t.click(id('mcp-directory-status'))
  await t.click('.ant-select-item-option[title="连接失败"]')
  t.check('状态筛选只留下真实失败项', await t.count('[data-testid^="mcp-select-"]'), 1)
  await t.click(id('mcp-directory-status'))
  await t.click('.ant-select-item-option[title^="全部状态"]')
  await t.click('button[aria-label="cached-only 快捷操作"]')
  t.ok('未选中项也能快捷启停、重载和复制', await t.waitForText('.ant-dropdown-menu','复制完整配置'))
  await t.key('Escape')
  t.check('快捷操作不改变当前 server', await t.count(id('mcp-server-alpha')), 1)
  const cached = await t.text(id('mcp-select-cached-only'))
  t.ok('只有缓存工具的服务器不会伪装成已连接', !cached.includes('已连接') && (cached.includes('缓存') || cached.includes('未连接')))

  await t.click(id('mcp-select-alpha'))
  t.ok('选择服务器打开真实详情', await t.waitFor(id('mcp-server-alpha')))
  t.ok('项目 scope 显示在详情', (await t.text(id('mcp-server-alpha'))).includes('项目'))
  t.ok('首次载入回显已有工具权限', await t.waitUntil(`document.querySelector('${id(`mcp-perm-${data.alphaTool}`)} .ant-segmented-item-selected')?.textContent === '禁用'`))
  await t.click(id('mcp-reload-alpha'))
  let snapshot = await t.act('snapshot')
  const reload = snapshot.calls.filter((call) => call.command === 'reload_mcp_server').at(-1)
  t.check('重载发往当前工作区与服务器', reload?.args, { workspace: data.workspace, name: 'alpha' })
  await t.act('publishRuntime', 'connecting')
  t.ok('详情跟随实时连接态', await t.waitForText(id('mcp-server-alpha'), '连接中'))
  t.check('连接中不重复重载', await t.js(`document.querySelector('${id('mcp-reload-alpha')}').disabled`), true)
  await t.act('publishRuntime', 'connected')
  if (!(await t.countVisible(id(`mcp-tool-${data.alphaTool}`)) )) await t.click(id('mcp-expand-alpha'))
  t.ok('详情显示真实工具', await t.waitFor(id(`mcp-tool-${data.alphaTool}`)))
  t.ok('详情状态跟到已连接', await t.waitForText(id('mcp-status-alpha'), '已连接 · 1 工具'))
  t.ok('目录与详情状态文字一致', (await t.text(id('mcp-select-alpha'))).includes(await t.text(id('mcp-status-alpha'))))
  t.ok('重载按钮写出文字', (await t.text(id('mcp-reload-alpha'))).includes('重载'))
  const actions = await t.js(`(() => {
    const row = document.querySelector('${id('mcp-actions-alpha')}').getBoundingClientRect()
    const reload = document.querySelector('${id('mcp-reload-alpha')}').getBoundingClientRect()
    const remove = document.querySelector('${id('mcp-delete-alpha')}').getBoundingClientRect()
    return { gap: remove.left - reload.right, rightEdge: row.right - remove.right, sameRow: Math.abs(remove.top - reload.top) < 2 }
  })()`)
  t.info('操作行几何', actions)
  t.ok('删除和其他操作隔开并靠右', actions.sameRow && actions.gap > 40 && actions.rightEdge <= 1)
  const serverText = await t.text(id('mcp-server-alpha'))
  t.ok('操作行和工具标题没有空标签', !serverText.includes('服务器连接') && !serverText.includes('默认策略'))
  await t.click(connectionTab)
  const configText = await t.text(`${id('mcp-detail')} [aria-label="连接配置"]`)
  t.ok('启动命令带上参数', configText.includes('node alpha.mjs'))
  t.ok('连接配置不再重复来源、连接方式和只读标注', !configText.includes('配置来源') && !configText.includes('连接方式') && !configText.includes('只读摘要'))
  t.check('编辑入口在连接配置里', await t.count(`${id('mcp-detail')} [aria-label="连接配置"] ${id('mcp-edit-alpha')}`), 1)
  t.ok('目录不再有即时生效脚注', !(await t.text(id('mcp-directory'))).includes('即时生效'))
  await t.click(toolsTab)
  await t.click(`${id(`mcp-perm-${data.alphaTool}`)} .ant-segmented-item:nth-child(2)`)
  snapshot = await t.act('snapshot')
  t.check('工具权限立即落盘', snapshot.policy.tools?.[data.alphaTool]?.permission, 'needs_approval')
  t.check('修改当前权限保留其他服务器的已有权限', snapshot.policy.tools?.mcp__beta__search?.permission, 'needs_approval')
  await t.click(id(`mcp-rules-${data.alphaTool}`))
  await t.click(id('tool-rule-add'))
  await t.click(id('tool-rule-match-0-add'))
  await replace(t, id('tool-rule-match-0-key-0'), 'path')
  await replace(t, id('tool-rule-match-0-val-0'), 'src/*')
  await t.click(id('tool-perm-save'))
  snapshot = await t.act('snapshot')
  t.check('参数规则保持可编辑并落盘', snapshot.policy.tools?.[data.alphaTool]?.rules?.[0]?.match, { path: 'src/*' })

  await t.click(id('mcp-toggle-alpha'))
  snapshot = await t.act('snapshot')
  t.check('停用保留原项目 scope', snapshot.entries.find((entry) => entry.name === 'alpha')?.scope, 'project')
  t.check('停用立即更新', snapshot.entries.find((entry) => entry.name === 'alpha')?.enabled, false)
  t.ok('停用后写明权限暂不生效', await t.waitFor(id('mcp-disabled-hint-alpha')))
  t.checkNear('停用后工具列表变淡', Number((await t.style(`${id('mcp-detail')} [data-server-enabled]`, ['opacity'])).opacity), 0.55, 0.01)
  await t.click(id('mcp-toggle-alpha'))
  await t.click(connectionTab)
  await t.click(id('mcp-edit-alpha'))
  t.check('编辑回显原配置', await t.js(`document.querySelector('${id('mcp-command')}').value`), 'node')
  await replace(t, id('mcp-args'), 'alpha-updated.mjs')
  await t.click(id('mcp-submit'))
  snapshot = await t.act('snapshot')
  const edit = snapshot.calls.filter((call) => call.command === 'upsert_mcp_config').at(-1)
  t.check('编辑写回原 project scope', edit?.args.scope, 'project')
  t.check('编辑保留启用状态', edit?.args.enabled, true)

  await t.click(id('mcp-add'))
  await replace(t, id('mcp-name'), 'new-server')
  await replace(t, id('mcp-command'), 'node')
  await t.click(id('mcp-submit'))
  t.ok('快速配置新增仍可用', await t.waitFor(id('mcp-select-new-server')))
  await t.click(id('mcp-add'))
  await t.click(id('mcp-tab-json'))
  await replace(t, id('mcp-json'), JSON.stringify({ mcpServers: { 'from-json': { command: 'node', args: ['server.mjs'] } } }))
  await t.click(id('mcp-import'))
  t.ok('JSON 导入仍可用', await t.waitFor(id('mcp-select-from-json')))

  await t.click(id('mcp-select-alpha'))
  await t.shot('mcp-wide-dark')
  for (const width of [920, 760, 520]) {
    await t.resize(width, 880)
    await checkBounds(t, `MCP ${width}px`)
    if (width <= 760) {
      const mcp = await t.rect(id('ext-tab-mcp'))
      const skills = await t.rect(id('ext-tab-skills'))
      t.ok(`${width}px 模块导航转横排`, Math.abs(mcp.y - skills.y) <= 1 && skills.x > mcp.x)
    }
    if (width === 520) {
      t.check('MCP 窄列只展示详情', await t.countVisible(id('mcp-directory')), 0)
      await t.click(id('mcp-back'))
      t.check('MCP 返回目录', await t.countVisible(id('mcp-directory')), 1)
    }
  }

}

export default async function (t) {
  await checkMcpManagement(t)
  await checkExtensionLibrary(t)
}

// Keep the original combined entry point; library changes can exercise just this workflow.
async function checkHeaderBaselines(t) {
  for (const width of [1420, 420, 360, 320]) {
    await t.resize(width, 880)
    let reference
    for (const [page, prefix] of [['mcp','mcp'],['skills','skill'],['commands','command'],['rules','rule']]) {
      await t.click(id('ext-tab-'+page))
      await t.waitFor(id(prefix+'-refresh'))
      const geometry = await t.js(`(() => {
        const header = document.querySelector('${id('extension-page-header')}');
        const title = header.querySelector('h2'), subtitle = header.lastElementChild;
        const actions = header.querySelector('[data-testid$="-refresh"]').parentElement;
        const px = value => Math.round(value * devicePixelRatio);
        return {title: px(title.getBoundingClientRect().top), titleLine: getComputedStyle(title).lineHeight,
          subtitle: px(subtitle.getBoundingClientRect().top), subtitleLine: getComputedStyle(subtitle).lineHeight,
          firstAction: px(actions.firstElementChild.getBoundingClientRect().top),
          primaryAction: px(actions.lastElementChild.getBoundingClientRect().top)};
      })()`)
      if (reference) t.check(`${width}px ${page} 标题、副标题、操作按钮与 MCP 的基准线一致`, geometry, reference)
      else reference = geometry
    }
  }
  await t.resize(1420, 880)
}

export async function checkExtensionLibrary(t) {
  await checkHeaderBaselines(t)
  const data = await t.data()
  let snapshot
  await t.resize(1420, 880)
  await t.click(id('ext-tab-skills'))
  t.ok('技能目录加载', await t.waitFor(id('skill-lint-helper')))
  t.check('旧 skill: 前缀偏好继续生效', await t.js(`document.querySelector('${id('skill-toggle-lint-helper')}').getAttribute('aria-checked')`), 'false')
  await t.click(id('skill-toggle-lint-helper'))
  t.ok('技能启用反馈更新', await t.waitUntil(`document.querySelector('${id('skill-toggle-lint-helper')}').getAttribute('aria-checked') === 'true'`))
  t.ok('技能行不再重复写启用状态', !(await t.text(id('skill-lint-helper'))).includes('已启用'))
  t.ok('技能行写出来源和路径', (await t.text(id('skill-source-lint-helper'))).length > 2)
  t.ok('刷新和打开目录带文字', (await t.text(id('skill-refresh'))).includes('刷新') && (await t.text(id('skill-open-dir'))).includes('打开目录'))
  t.check('短目录也可组合筛选', await t.count(id('skill-filter')), 1)
  await t.click(id('skill-status'))
  await t.click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="未启用"]')
  t.ok('已全部启用：未启用筛选无结果', await t.waitForText(id('skill-catalog'), '没有匹配'))
  await t.click(id('skill-status'))
  await t.click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="全部状态"]')
  await t.click(id('skill-scope'))
  await t.click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="项目"]')
  t.check('项目筛选只留项目技能', await t.count(id('skill-catalog') + ' > [data-testid]'), 1)
  await t.click(id('skill-scope'))
  await t.click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="全部范围"]')
  t.ok('显式触发徽章', (await t.text(id('skill-skill-3'))).includes('仅手动'))
  await t.click(id('skill-lint-helper') + ' button:not([role=switch])')
  t.ok('技能全文加载', await t.waitForText('.cm-content', '检查步骤'))
  await t.click(id('skill-detail') + ' summary')
  await t.click(id('skill-detail') + ' li summary')
  t.ok('技能资源树显示脚本', await t.waitForText(id('skill-detail'), 'check.js'))
  await t.click(id('skill-detail-edit'))
  await t.click('.cm-content'); await t.key('End',['control']); await t.insertText('编辑后正文')
  await t.click(id('skill-detail-save'))
  t.ok('编辑回写完整正文', await t.waitUntil("window.__uiEvents.includes('save_skill')"))
  await t.shot('skill-detail-dark')
  await t.clickReady('.ant-drawer-close')
  t.ok('已保存的技能可直接关闭详情', await t.waitUntil("!document.querySelector('[data-testid=skill-detail]')"))
  const catalogRange = () => t.js(`(() => { const el = document.querySelector('${id('skill-catalog-scroll')}'); return el.scrollHeight-el.clientHeight; })()`)
  t.info('880px 高窗中的八条技能目录滚动范围', await catalogRange())
  await t.resize(1420,550)
  t.ok('矮窗目录有实际溢出内容', await catalogRange()>0)
  const skillHeaderBefore = await t.rect(id('skill-add'))
  await t.wheel(id('skill-catalog-scroll'), 600)
  const skillScroll = await t.js(`({ catalog: document.querySelector('${id('skill-catalog-scroll')}').scrollTop, outer: document.querySelector('${id('extensions-body')}').scrollTop })`)
  t.info('技能滚动', skillScroll)
  t.ok('滚轮只滚技能目录', skillScroll.catalog > 0 && skillScroll.outer === 0)
  t.checkNear('滚动时页头按钮不动', (await t.rect(id('skill-add'))).y, skillHeaderBefore.y, 1)
  await t.wheel(id('skill-catalog-scroll'), -10000)
  await t.resize(1420,880)
  t.ok('技能偏好自动写盘', await t.waitUntil(`window.__uiEvents.includes('set_settings')`))
  snapshot = await t.act('snapshot')
  t.check('启用移除禁用偏好', snapshot.settings.SKILLS_DISABLED, '')
  await t.click(id('skill-view-grid'))
  t.check('技能切换网格', await t.js(`document.querySelector('${id('skill-catalog')}').dataset.view`), 'grid')
  const first = await t.rect(id('skill-lint-helper'))
  const second = await t.rect(id('skill-skill-2'))
  t.ok('宽工作台网格实际多列排列', second.x > first.x && Math.abs(second.y - first.y) <= 1)
  await checkSkillGrid(t, '8 个技能')
  await t.act('setManySkills', true)
  await t.click(id('ext-tab-skills'))
  t.ok('40 个技能加载', await t.waitFor(id('skill-many-40')))
  t.check('40 个技能仍是网格', await t.js(`document.querySelector('${id('skill-catalog')}').dataset.view`), 'grid')
  await checkSkillGrid(t, '40 个技能')
  t.ok('中英文均限两行、长短卡片等高', await t.js(`(() => {
    const summaries = ['many-02','many-03'].map(name => document.querySelector('[data-testid="skill-summary-' + name + '"]'));
    const heights = [...document.querySelectorAll('[data-testid="skill-catalog"] > div')].map(el => el.getBoundingClientRect().height);
    return Math.max(...heights)-Math.min(...heights) <= 1 && summaries.every(el => getComputedStyle(el).webkitLineClamp === '2' && el.scrollHeight > el.clientHeight && el.clientHeight <= 2 * parseFloat(getComputedStyle(el).lineHeight) + 1);
  })()`))
  await t.shot('skills-grid-many')
  await t.act('setManySkills', false)
  await t.click(id('ext-tab-skills'))
  await t.waitFor(id('skill-lint-helper'))
  await t.click(id('skill-add'))
  await replace(t, id('skill-name'), 'created-skill')
  await replace(t, id('skill-description'), '检查新增入口')
  await replace(t, id('skill-body'), '使用真实技能表单。')
  await t.click(id('skill-submit'))
  t.ok('技能新增仍可用', await t.waitFor(id('skill-created-skill')))
  await t.click(id('skill-import'))
  await clickMenuText(t, '导入技能目录')
  t.ok('技能导入仍可用', await t.waitFor(id('skill-imported-skill')))
  await t.click(id('skill-import'))
  await clickMenuText(t, '从 Zip 安装')
  t.ok('ZIP 导入请求使用文件选择器', await t.waitUntil(`window.__uiEvents.includes('pick-file:zip')`))
  snapshot = await t.act('snapshot')
  t.check('ZIP 导入收到所选文件', snapshot.calls.filter((call) => call.command === 'install_skill_from_zip').at(-1)?.args, { src: '/fixtures/skill.zip' })
  await t.click(id('skill-import'))
  await clickMenuText(t, '导入单文件 (SKILL.md)')
  t.ok('单文件导入请求使用 Markdown 文件选择器', await t.waitUntil(`window.__uiEvents.includes('pick-file:md,markdown')`))
  snapshot = await t.act('snapshot')
  t.check('单文件导入收到所选文件', snapshot.calls.filter((call) => call.command === 'import_skill_from_file').at(-1)?.args, { src: '/fixtures/SKILL.md' })
  t.check('行内不暴露删除按钮', await t.count(id('skill-delete-created-skill')), 0)
  await reveal(t, id('skill-more-created-skill'))
  await t.click(id('skill-more-created-skill'))
  await t.click(id('skill-delete-created-skill'))
  t.check('技能删除先等待确认', (await t.act('snapshot')).calls.some((call) => call.command === 'delete_skill'), false)
  t.check('技能删除确认可见', await t.countVisible(id('skill-delete-confirm-created-skill')), 1)
  await t.click('.ant-modal .ant-btn-default')
  t.check('取消删除保留目录', await t.count(id('skill-created-skill')), 1)
  await t.click(id('skill-more-created-skill'))
  await t.click(id('skill-delete-created-skill'))
  await t.click(id('skill-delete-confirm-created-skill'))
  t.ok('确认后移除技能', await t.waitUntil(`!document.querySelector('${id('skill-created-skill')}')`))
  await t.click(id('skill-view-list'))
  t.ok('技能超过 8 个时出现筛选框', await t.waitFor(id('skill-filter')))
  await replace(t, id('skill-filter'), 'lint')
  t.ok('筛选只留命中的技能', await t.waitUntil(`document.querySelectorAll('${id('skill-catalog')} > [data-testid^="skill-"]').length === 1`))
  await t.click(id('skill-filter'), 20)
  await t.key('a', ['control'])
  await t.key('Backspace')
  t.ok('清空筛选后技能都回来', await t.waitUntil(`document.querySelectorAll('${id('skill-catalog')} > [data-testid^="skill-"]').length === 9`))
  for (const width of [920, 760, 520]) {
    await t.resize(width, 880)
    await checkBounds(t, `技能 ${width}px`)
  }
  await t.resize(520, 430)
  await reveal(t, id('skill-imported-skill'))
  const lastSkill = await t.rect(id('skill-imported-skill'))
  t.ok('短窗技能末项可滚到视口内', lastSkill.y >= 0 && lastSkill.bottom <= 430)
  await t.shot('skills-narrow-short')

  await t.click(id('skill-more-imported-skill'))
  await clickMenuText(t,'禁用并归档')
  t.ok('归档后移出列表', await t.waitUntil("!document.querySelector('[data-testid=skill-imported-skill]')"))
  await checkDraftResize(t, 'commands', 'command-item-refactor', 'command-list', 'command-editor', 'command-back', ' 增加 {scope}')
  const pillColors = await t.js(`(() => {
    const pill = document.querySelector('${id('command-list')} [data-command]')
    return { label: getComputedStyle(pill.firstElementChild).color, text: getComputedStyle(pill.parentElement).color }
  })()`)
  t.check('命令目录胶囊使用工作台正文颜色', pillColors.label, pillColors.text)
  t.ok('命令参数继续实时识别', await t.waitForText(id('command-detected-params'), 'scope'))
  t.ok('改过的命令标出未保存', await t.waitFor(id('command-dirty')))
  await t.click(id('command-item-review'), 20)
  t.check('换命令前弹出放弃确认', await t.waitUntil(`[...document.querySelectorAll('.ant-modal-confirm')].some((el) => el.checkVisibility())`), true)
  const cancelPoint = await t.js(`(() => { const b = [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].find((el) => el.checkVisibility() && !el.classList.contains('ant-btn-dangerous')); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await t.click(cancelPoint)
  t.ok('取消后确认框关闭', await t.waitUntil(`![...document.querySelectorAll('.ant-modal-confirm')].some((el) => el.checkVisibility())`))
  t.check('取消后草稿还在', await t.js(`document.querySelector('${id('command-name-input')}').value`), 'refactor')
  t.ok('取消后正文修改还在', (await t.js(`document.querySelector(${JSON.stringify(body)}).value`)).includes('增加 {scope}'))
  const commandText = await t.text(id('command-workbench'))
  t.ok('命令页不再重复写范围和用法', !commandText.includes('全局可用') && !commandText.includes('全部命令') && !commandText.includes('参数会在调用命令时填写'))
  t.check('命令删除按钮文字不加空格', (await t.text(id('command-delete'))).trim(), '删除')
  await replace(t, id('command-name-input'), 'goal')
  t.ok('保留命令名继续即时校验', await t.waitForText(id('command-error'), '/goal'))
  t.check('错误命令不可保存', await t.js(`document.querySelector('${id('command-save')}').disabled`), true)

  await checkRulesWorkbench(t)

  await t.act('showChrome',true)
  await t.waitFor('[data-testid="titlebar-brand"]')
  const headerGeometry = []
  for (const page of ['mcp', 'skills', 'commands', 'rules']) {
    await t.click(id(`ext-tab-${page}`))
    if (page === 'commands') { await t.waitFor(id('command-item-review')); await t.click(id('command-item-review'), 20) }
    if (page === 'rules') { await t.waitFor(id('rule-open-global-zh')); await t.click(id('rule-open-global-zh'), 20) }
    if (page === 'skills') { await t.waitFor(id('skill-view-list')); await t.click(id('skill-view-list')) }
    const actionId = {mcp:'mcp', skills:'skill', commands:'command', rules:'rule'}[page]
    headerGeometry.push(await t.js(`(() => {
      const header = document.querySelector('[data-testid="extension-page-header"]');
      const buttons = [...header.querySelectorAll('button')].map(b => b.getBoundingClientRect());
      const title = header.querySelector('h2').getBoundingClientRect();
      return [title.x, title.y, buttons.at(-1).right, buttons.at(-1).y, buttons.at(-1).height, buttons[1].left-buttons[0].right].map(px => Math.round(px * devicePixelRatio))
    })()`))
    await t.hover(id('extension-page-header')+' h2')
    for (const mode of ['dark','light']) {
      await t.setTheme(mode)
      await t.js('document.fonts.ready.then(()=>true)')
      await checkPageHeading(t,mode+' '+page,id('extension-page-header')+' h2')
      t.ok(mode+' '+page+' 的刷新操作始终为 filled',
        await t.js(`document.querySelector('${id(actionId+'-refresh')}').classList.contains('ant-btn-variant-filled')`))
      if (page === 'commands') {
        const danger = await t.js(`(() => {
          const button = document.querySelector('${id('command-delete')}'), style = getComputedStyle(button);
          return { role: button.classList.contains('ant-btn-color-dangerous'), color: style.color };
        })()`)
        t.ok(mode+' 命令删除按钮保留危险色角色', danger.role)
        if (mode === 'light') t.checkColor('浅色命令删除为危险红色', danger.color, 'rgb(220, 38, 38)', 0)
        else {
          const rgb = danger.color.match(/[\d.]+/g)?.map(Number)
          t.ok('深色命令删除显示红色前景', !!rgb && rgb[0] > Math.max(rgb[1], rgb[2]) + 35)
        }
      }
      await compareThemeGeometry(t,page+' 扩展页面','#root',mode==='dark'?'before':'after')
      await checkBounds(t,mode+' '+page)
      await t.shot(page+'-'+mode)
    }
    await t.click(id(actionId + '-open-dir'))
    const directoryCall = (await t.act('snapshot')).calls.filter(({command}) => ['open_skills_dir','open_mcp_directory','extension_directory'].includes(command)).at(-1)
    t.check('打开目录定位到 ' + page, directoryCall.command, {mcp:'open_mcp_directory',skills:'open_skills_dir',commands:'extension_directory',rules:'extension_directory'}[page])
    if (['rules','commands'].includes(page)) t.check('打开的是实际模块目录', [directoryCall.args.kind,directoryCall.args.open], [page,true])
  }
  for (const geometry of headerGeometry.slice(1)) t.check('四页标题、主按钮及操作间距对齐', geometry, headerGeometry[0])
  const light = await t.style(id('extension-stage'), ['background-color'])
  t.ok('浅色主题使用浅背景', /^rgba?\((\d+)/.exec(light.backgroundColor)?.[1] > 200)
  await t.shot('extensions-light')
  await t.act('showChrome',false)
  await t.setTheme('dark')
  await t.act('clearCommands')
  await t.click(id('ext-tab-commands'))
  t.ok('空命令目录显示四个模板', await t.waitFor(id('template-review')) && await t.count('[data-testid^="template-"]') === 4)
  t.check('空目录没有左右空框', await t.count(id('command-workbench')), 0)
  t.check('路径保持 Windows 原样', await t.text(id('command-directory')), 'C:\\Users\\Example\\.pi\\agent\\prompts')
  await t.resize(1420,880)
  await t.shot('command-empty-dark')
  await t.click(id('template-review'))
  t.check('模板进入编辑', await t.js(`document.querySelector('${id('command-name-input')}').value`), 'review')
  t.ok('调用预览包含参数', (await t.text(id('command-preview'))).includes('/review [参数…]'))
  await t.click(id('command-save'))
  t.ok('模板保存后进入命令列表', await t.waitFor(id('command-item-review')))
}

// 可单独验证规则页在真实扩展工作台里的尺寸、开关与编辑草稿。
export async function checkRulesWorkbench(t) {
  const data = await t.data()
  await t.click(id('ext-tab-rules'))
  await t.waitFor(id('rule-toggle-project-pnpm'))
  const styles = () => Promise.all([id('rule-workbench'), id('rule-list'), id('rule-detail-title'), id('rule-refresh')].map(
    (selector) => t.style(selector, ['background-color', 'border-color', 'color', 'box-shadow'])))
  await t.hover(id('extension-page-header') + ' h2')
  await t.sleep(200)
  const dark = await styles()
  await t.shot('theme-rules-dark')
  await t.setTheme('light')
  const workbench = await t.style(id('rule-workbench'), ['background-color', 'border-top-color', 'box-shadow'])
  t.checkColor('浅色规则面板为白色表面', workbench?.backgroundColor, white, 0)
  t.checkColor('浅色规则面板为冷灰边线', workbench?.borderTopColor, border, 0)
  t.check('浅色规则面板保持与深色相同的阴影', workbench?.boxShadow, dark[0]?.boxShadow)
  const list = await t.style(id('rule-list'), ['background-color', 'border-right-color'])
  t.checkColor('浅色规则目录为微灰背景', list?.backgroundColor, sidebar, 0)
  t.checkColor('浅色规则目录分割线', list?.borderRightColor, border, 0)
  t.checkColor('浅色规则详情标题', (await t.style(id('rule-detail-title'), ['color']))?.color, ink, 0)
  t.ok('浅色规则刷新沿用共享 filled 控件', await t.js(`document.querySelector('${id('rule-refresh')}').classList.contains('ant-btn-variant-filled')`))
  await checkDenseControl(t, '规则范围', id('rule-list') + ' .ant-segmented')
  await t.shot('theme-rules-light')
  await t.setTheme('dark')
  t.check('从浅色切回后规则深色表面与控件样式恢复', await styles(), dark)
  await t.click(id('rule-toggle-project-pnpm'))
  const snapshot = await t.act('snapshot')
  t.check('规则开关立即写入当前工作区', snapshot.calls.filter((call) => call.command === 'set_context_rule_enabled').at(-1)?.args, { workspace: data.workspace, scope: 'project', id: 'pnpm', enabled: true })
  await checkDraftResize(t, 'rules', 'rule-open-global-zh', 'rule-list', 'rule-editor', 'rule-back', ' 保留未保存的修改。')
  t.ok('改过的规则标出未保存', await t.waitFor(id('rule-dirty')))
  t.ok('详情开关写出状态', (await t.text(id('rule-editor'))).includes('已启用'))
  t.ok('范围下写出保存目录', (await t.text(id('rule-scope-path'))).includes('/agent/rules/zh.md'))
  t.check('没选模式时「全部」亮起', await t.js(`document.querySelector('${id('rule-mode-all')}').getAttribute('aria-pressed')`), 'true')
  await t.click(id('rule-toggle-project-pnpm'))
  t.ok('停用后行标记为停用', await t.waitUntil(`document.querySelector('${id('rule-item-project-pnpm')}').dataset.enabled === 'false'`))
  t.checkNear('停用的规则在列表里变淡', Number((await t.style(`${id('rule-item-project-pnpm')} > button:not([role=switch])`, ['opacity'])).opacity), 0.55, 0.01)
  await t.click(id('rule-toggle-project-pnpm'))
  t.ok('重新启用后恢复', await t.waitUntil(`document.querySelector('${id('rule-item-project-pnpm')}').dataset.enabled === 'true'`))
  t.ok('规则页不再有列表底部长提示', !(await t.text(id('rule-list'))).includes('AGENTS.md'))
}
