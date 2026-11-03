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

async function checkToolFilterAndBulk(t) {
  t.ok('长工具夹具默认选中 alpha', await t.waitUntil(`document.querySelector('${id('mcp-select-alpha')}')?.getAttribute('aria-pressed') === 'true'`))
  t.ok('工具多时出现筛选框', await t.waitFor(id('mcp-tool-filter-alpha')))
  t.check('筛选前列出全部 40 个工具', await t.count(toolRows), 40)
  await replace(t, id('mcp-tool-filter-alpha'), 'tool_3')
  t.ok('筛选只留短名命中的 11 个工具', await t.waitUntil(`document.querySelectorAll('${toolRows}').length === 11`))
  await t.click(id('mcp-tool-filter-alpha'), 20)
  await t.key('a', ['control'])
  await t.key('Backspace')
  t.ok('清空筛选后工具全部回来', await t.waitUntil(`document.querySelectorAll('${toolRows}').length === 40`))
  await t.click(id('mcp-perm-all-disabled'), 10)
  const snapshot = await t.act('snapshot')
  t.check('全部设为一次写入首尾工具', ['mcp__alpha__tool_1', 'mcp__alpha__tool_39'].map((name) => snapshot.policy.tools?.[name]?.permission), ['disabled', 'disabled'])
  t.check('全部设为保留其他服务器的权限', snapshot.policy.tools?.mcp__beta__search?.permission, 'needs_approval')
}

async function checkCrowdedMcp(t) {
  await t.act('setCrowdedMcp', true)
  t.ok('长MCP夹具加载24个服务器', await t.waitFor(id('mcp-select-extra-20')))
  await checkToolFilterAndBulk(t)
  for (const size of [[1420, 880], [1420, 430], [520, 430]]) {
    const [width, height] = size, label = `${width}×${height}`
    await t.resize(width, height)
    await t.sleep(100)
    await mcpFrame(t, label)
    if (width > 680) {
      const ranges = await t.js(`(() => {
        const directory = document.querySelector('${id('mcp-directory')}'), detail = document.querySelector('${id('mcp-detail')}')
        const tools = document.querySelector('${id('mcp-tool-list-alpha')}')
        return { directory: directory.scrollHeight - directory.clientHeight, detail: detail.scrollHeight - detail.clientHeight, tools: tools.scrollHeight - tools.clientHeight }
      })()`)
      t.info(`${label} 滚动范围`, ranges)
      t.ok(`${label} 目录有独立滚动范围`, ranges.directory > 0)
      t.ok(`${label} 工具列表有独立滚动范围`, ranges.tools > 0)
      if (height >= 880) t.ok(`${label} 详情栏本身不滚动`, ranges.detail <= 1)
    }
  }
  await t.resize(1420, 880)
  await t.js(`document.querySelector('${id('mcp-directory')}').scrollTop = 0; document.querySelector('${id('mcp-tool-list-alpha')}').scrollTop = 0`)
  const before = await mcpFrame(t, '滚动前')
  const configRect = () => t.js(`(() => { const r = document.querySelector('${id('mcp-detail')} [aria-label="连接配置"]').getBoundingClientRect(), d = document.querySelector('${id('mcp-detail')}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, gap: d.bottom - r.bottom, inside: r.top >= d.top && r.bottom <= d.bottom } })()`)
  const configBefore = await configRect()
  t.info('连接配置位置', configBefore)
  t.ok('连接配置不用滚动就贴在详情底部', configBefore.inside && configBefore.gap <= 24)
  await t.wheel(id('mcp-directory'), 500)
  const scrolls = () => t.js(`({ directory: document.querySelector('${id('mcp-directory')}').scrollTop, detail: document.querySelector('${id('mcp-detail')}').scrollTop, tools: document.querySelector('${id('mcp-tool-list-alpha')}').scrollTop, outer: document.querySelector('${id('extensions-body')}').scrollTop })`)
  const afterDirectory = await scrolls()
  t.ok('真实滚轮使服务器目录内部滚动', afterDirectory.directory > 0)
  t.check('目录滚动不带动工具列表', afterDirectory.tools, 0)
  t.check('目录滚动不带动外层', afterDirectory.outer, 0)
  await t.wheel(id('mcp-tool-list-alpha'), 500)
  const afterTools = await scrolls()
  t.ok('真实滚轮只滚工具列表', afterTools.tools > 0)
  t.check('工具列表滚动不带动详情栏', afterTools.detail, 0)
  t.checkNear('工具列表滚动不带动目录', afterTools.directory, afterDirectory.directory, 1)
  t.check('工具列表滚动不带动外层', afterTools.outer, 0)
  await t.wheel(id('mcp-directory'), 10000)
  await t.wheel(id('mcp-tool-list-alpha'), 10000)
  const configAfter = await configRect()
  t.checkNear('滚到工具末尾时连接配置原地不动', configAfter.top, configBefore.top, 1)
  const reachable = await t.js(`(() => {
    const directory = document.querySelector('${id('mcp-directory')}').getBoundingClientRect()
    const list = document.querySelector('${id('mcp-tool-list-alpha')}').getBoundingClientRect()
    const lastServer = document.querySelector('${id('mcp-select-extra-20')}').getBoundingClientRect()
    const lastTool = document.querySelector('${id('mcp-tool-mcp__alpha__tool_39')}').getBoundingClientRect()
    return { lastServer: lastServer.top >= directory.top && lastServer.bottom <= directory.bottom, lastTool: lastTool.top >= list.top && lastTool.bottom <= list.bottom + 1 }
  })()`)
  t.ok('目录底部的服务器可到达', reachable.lastServer)
  t.ok('工具列表末项可到达', reachable.lastTool)
  const after = await mcpFrame(t, '滚动后')
  t.checkNear('内部滚动后外框顶边不移动', after.frame.y, before.frame.y, 1)
  t.checkNear('内部滚动后外框高度不变', after.frame.height, before.frame.height, 1)
  await t.shot('mcp-crowded-bounded')
  await t.wheel(id('mcp-directory'), -10000)
  await t.wheel(id('mcp-tool-list-alpha'), -10000)
  await t.setTheme('light')
  await t.shot('mcp-contained-wide-light')
  await t.resize(520, 430)
  await mcpFrame(t, '窄短窗目录')
  await t.wheel(id('mcp-directory'), 500)
  t.ok('窄短窗服务器目录内部可滚动', await t.js(`document.querySelector('${id('mcp-directory')}').scrollTop > 0`))
  await t.wheel(id('mcp-directory'), -10000)
  await t.click(id('mcp-select-alpha'), 20)
  await mcpFrame(t, '窄短窗详情')
  t.check('窄短窗仅显示详情', await t.countVisible(id('mcp-directory')), 0)
  await t.wheel(id('mcp-detail'), 10000)
  await t.js(`document.querySelector('${id('mcp-tool-list-alpha')}').scrollIntoView({ block: 'nearest' })`)
  await t.wheel(id('mcp-tool-list-alpha'), 10000)
  const narrowEnd = await t.js(`(() => {
    const detail = document.querySelector('${id('mcp-detail')}'), r = detail.getBoundingClientRect()
    const summary = detail.querySelector('[aria-label="连接配置"]').getBoundingClientRect()
    const tools = document.querySelector('${id('mcp-tool-list-alpha')}')
    return { scroll: detail.scrollTop, tools: tools.scrollTop, toolsHeight: tools.clientHeight, reached: summary.top >= r.top && summary.bottom <= r.bottom, outer: document.querySelector('${id('extensions-body')}').scrollTop }
  })()`)
  t.info('窄短窗详情滚动', narrowEnd)
  t.ok('窄短窗工具列表保底 120px 并可滚动', narrowEnd.toolsHeight >= 119 && narrowEnd.tools > 0)
  t.ok('窄短窗底部配置可到达', narrowEnd.reached)
  t.check('窄短窗外层仍不滚动', narrowEnd.outer, 0)
  await t.wheel(id('mcp-tool-list-alpha'), -10000)
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

export default async function (t) {
  const data = await t.data()
  t.ok('真实扩展模块加载', await t.waitFor(id('mcp-select-alpha')))
  await checkCrowdedMcp(t)
  const navMcp = await t.rect(id('ext-tab-mcp'))
  const navSkills = await t.rect(id('ext-tab-skills'))
  const workbench = await t.rect(id('mcp-workbench'))
  t.ok('宽模块使用纵向导航', navSkills.y > navMcp.y && Math.abs(navSkills.x - navMcp.x) <= 1)
  t.ok('宽模块导航与工作台并列', workbench.x > navMcp.right)
  await checkBounds(t, 'MCP 1420px')
  t.ok('缓存工具不掩盖真实连接失败', (await t.text(id('mcp-select-alpha'))).includes('连接失败'))
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
  const configText = await t.text(`${id('mcp-detail')} [aria-label="连接配置"]`)
  t.ok('启动命令带上参数', configText.includes('node alpha.mjs'))
  t.ok('连接配置不再重复来源、连接方式和只读标注', !configText.includes('配置来源') && !configText.includes('连接方式') && !configText.includes('只读摘要'))
  t.check('编辑入口在连接配置里', await t.count(`${id('mcp-detail')} [aria-label="连接配置"] ${id('mcp-edit-alpha')}`), 1)
  t.ok('目录不再有即时生效脚注', !(await t.text(id('mcp-directory'))).includes('即时生效'))
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

  await t.resize(1420, 880)
  await t.click(id('ext-tab-skills'))
  t.ok('技能目录加载', await t.waitFor(id('skill-lint-helper')))
  t.check('旧 skill: 前缀偏好继续生效', await t.js(`document.querySelector('${id('skill-toggle-lint-helper')}').getAttribute('aria-checked')`), 'false')
  await t.click(id('skill-toggle-lint-helper'))
  t.ok('技能启用反馈更新', await t.waitUntil(`document.querySelector('${id('skill-toggle-lint-helper')}').getAttribute('aria-checked') === 'true'`))
  t.ok('技能行不再重复写启用状态', !(await t.text(id('skill-lint-helper'))).includes('已启用'))
  t.ok('技能行写出来源和路径', (await t.text(id('skill-source-lint-helper'))).length > 2)
  t.ok('刷新和打开目录带文字', (await t.text(id('skill-refresh'))).includes('刷新') && (await t.text(id('skill-open-dir'))).includes('打开目录'))
  t.check('8 个技能时不出筛选框', await t.count(id('skill-filter')), 0)
  const skillHeaderBefore = await t.rect(id('skill-add'))
  await t.wheel(id('skill-catalog-scroll'), 600)
  const skillScroll = await t.js(`({ catalog: document.querySelector('${id('skill-catalog-scroll')}').scrollTop, outer: document.querySelector('${id('extensions-body')}').scrollTop })`)
  t.info('技能滚动', skillScroll)
  t.ok('滚轮只滚技能目录', skillScroll.catalog > 0 && skillScroll.outer === 0)
  t.checkNear('滚动时页头按钮不动', (await t.rect(id('skill-add'))).y, skillHeaderBefore.y, 1)
  await t.wheel(id('skill-catalog-scroll'), -10000)
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
  await reveal(t, id('skill-delete-created-skill'))
  await t.click(id('skill-delete-created-skill'))
  t.check('技能删除先等待确认', (await t.act('snapshot')).calls.some((call) => call.command === 'delete_skill'), false)
  t.check('技能删除确认可见', await t.countVisible(id('skill-delete-confirm-created-skill')), 1)
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

  await t.click(id('ext-tab-rules'))
  await t.waitFor(id('rule-toggle-project-pnpm'))
  await t.click(id('rule-toggle-project-pnpm'))
  snapshot = await t.act('snapshot')
  t.check('规则开关立即写入当前工作区', snapshot.calls.filter((call) => call.command === 'set_context_rule_enabled').at(-1)?.args, { workspace: data.workspace, scope: 'project', id: 'pnpm', enabled: true })
  await checkDraftResize(t, 'rules', 'rule-open-global-zh', 'rule-list', 'rule-editor', 'rule-back', ' 保留未保存的修改。')
  t.ok('改过的规则标出未保存', await t.waitFor(id('rule-dirty')))
  t.ok('详情开关写出状态', (await t.text(id('rule-editor'))).includes('已启用'))
  t.ok('范围下写出保存目录', (await t.text(id('rule-scope-path'))).includes('~/.pi/agent/rules'))
  t.check('没选模式时「全部」亮起', await t.js(`document.querySelector('${id('rule-mode-all')}').getAttribute('aria-pressed')`), 'true')
  await t.click(id('rule-toggle-project-pnpm'))
  t.ok('停用后行标记为停用', await t.waitUntil(`document.querySelector('${id('rule-item-project-pnpm')}').dataset.enabled === 'false'`))
  t.checkNear('停用的规则在列表里变淡', Number((await t.style(`${id('rule-item-project-pnpm')} > button`, ['opacity'])).opacity), 0.55, 0.01)
  await t.click(id('rule-toggle-project-pnpm'))
  t.ok('重新启用后恢复', await t.waitUntil(`document.querySelector('${id('rule-item-project-pnpm')}').dataset.enabled === 'true'`))
  t.ok('规则页不再有列表底部长提示', !(await t.text(id('rule-list'))).includes('AGENTS.md'))

  await t.setTheme('light')
  for (const page of ['mcp', 'skills', 'commands', 'rules']) {
    await t.click(id(`ext-tab-${page}`))
    if (page === 'commands') { await t.waitFor(id('command-item-review')); await t.click(id('command-item-review'), 20) }
    if (page === 'rules') { await t.waitFor(id('rule-open-global-zh')); await t.click(id('rule-open-global-zh'), 20) }
    if (page === 'skills') { await t.waitFor(id('skill-view-list')); await t.click(id('skill-view-list')) }
    await checkBounds(t, `浅色 ${page}`)
    await t.shot(`${page}-light`)
  }
  const light = await t.style(id('extension-stage'), ['background-color'])
  t.ok('浅色主题使用浅背景', /^rgba?\((\d+)/.exec(light.backgroundColor)?.[1] > 200)
  await t.shot('extensions-light')
}
