/**
 * Ultra 独立模式：真实 ModeAction + 真实 SettingsPanel。
 * - 模式选择器里有 Ultra（带图标和文字），与其它模式并列互斥；
 * - 会话有未确认计划时手切 Ultra 被宿主拒绝，选择器退回 Plan 并提示确认执行；
 * - 计划确认后才切得进 Ultra；再切 Ask 就是 Ask，不叠加；
 * - 设置里 Ultra 是独立分组：Ultra 键与普通子代理键各存各的、互不覆盖，普通键留空/未设不会变成 Ultra 的回退值；
 * - 切分类不丢未保存值；保存后重新挂载按落盘恢复；浅色主题。
 */

const PANEL = '[data-testid="settings-panel"]'
const OPEN_OPTIONS = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'

const selectText = (key) =>
  `(document.querySelector('[data-testid="${key}"]')?.closest('.ant-select')?.textContent ?? '')`

const fieldCount = async (t, key) => t.count(`[data-testid="${key}"]`)

async function waitSelectText(t, key, text) {
  return t.waitUntil(`${selectText(key)}.includes(${JSON.stringify(text)})`)
}

/** 等模型字段拿到目录、从手填 Input 变成供应商 + 模型两个 Select。 */
async function waitModelField(t, key) {
  return t.waitFor(`[data-testid="${key}-provider"]`, 15000)
}

/** 打开 antd Select 并按选项标题点一条。 */
async function pick(t, testId, title) {
  await t.js(`document.querySelector('[data-testid="${testId}"]')?.scrollIntoView({ block: 'center' })`)
  await t.sleep(150)
  await t.click(`[data-testid="${testId}"]`, 20)
  t.ok(`下拉打开（${title}）`, await t.waitFor(`${OPEN_OPTIONS}[title="${title}"]`))
  await t.click(`${OPEN_OPTIONS}[title="${title}"]`, 20)
  await t.sleep(150)
}

/** 只取真正可见的 option（下拉关掉后旧选项还留在 DOM 里）。 */
const VISIBLE_OPTIONS = `[...document.querySelectorAll('[role="option"]')].filter((el) => el.getClientRects().length > 0)`

/** 打开模式下拉，点文字匹配的选项。 */
async function pickMode(t, label) {
  await t.js(`document.querySelectorAll('[data-probe="mode-option"]').forEach((el) => el.removeAttribute('data-probe'))`)
  await t.click('[data-testid="mode-action"] [role="combobox"]', 12)
  t.ok(
    `模式下拉里有 ${label}`,
    await t.waitUntil(`${VISIBLE_OPTIONS}.some((el) => el.textContent.trim() === ${JSON.stringify(label)})`),
  )
  await t.js(`(() => {
    const el = ${VISIBLE_OPTIONS}.find((o) => o.textContent.trim() === ${JSON.stringify(label)})
    el?.setAttribute('data-probe', 'mode-option')
  })()`)
  await t.click('[data-probe="mode-option"]', 12)
}

const toastHas = (t, text) =>
  t.waitUntil(`[...document.querySelectorAll('.ant-message-notice')].some((el) => el.textContent.includes(${JSON.stringify(text)}))`)

export default async function (t) {
  const { blockMessage } = await t.data()

  // —— 模式入口：Ultra 与其它模式并列，带图标与文字 ——
  t.ok('模式选择器渲染', await t.waitFor('[data-testid="mode-action"]'))
  t.ok('当前是 Plan', await t.waitForText('[data-testid="mode-action"]', 'Plan'))
  await t.click('[data-testid="mode-action"] [role="combobox"]', 12)
  t.ok('下拉打开', await t.waitFor('[role="option"]'))
  await t.sleep(200)
  const options = await t.js(
    `${VISIBLE_OPTIONS}.map((el) => ({ text: el.textContent.trim(), icons: el.querySelectorAll('svg').length }))`,
  )
  t.info('模式选项', options)
  const labels = options.map((o) => o.text)
  const ultra = options.find((o) => o.text === 'Ultra')
  t.ok('Ultra 是独立选项', Boolean(ultra))
  const anyIcon = await t.js(
    `document.querySelectorAll('[data-testid="mode-action"] svg, [role="listbox"] svg, .ant-select-dropdown svg').length`,
  )
  t.ok('模式选项带图标（含 Ultra）', (ultra?.icons ?? 0) > 0 || anyIcon > 0)
  t.check('Ultra 只出现一次', labels.filter((label) => label === 'Ultra').length, 1)
  t.check('只保留五种工作模式', labels.length, 5)
  t.check('Brainstorm 已从模式列表移除', labels.includes('Brainstorm'), false)
  for (const label of ['Agent', 'Ask', 'Debug', 'Plan', 'Ultra']) {
    t.ok(`Ultra 与 ${label} 并列在同一模式列表`, labels.includes(label))
  }
  await t.key('Escape')
  await t.sleep(200)

  // —— 未确认 Plan：手切 Ultra 被拦 ——
  await pickMode(t, 'Ultra')
  t.ok('手切 Ultra 发给了宿主', (await t.events()).includes('set-mode:ultra'))
  t.ok('提示去侧栏确认执行', await toastHas(t, '确认执行'))
  t.ok('提示是宿主原文', await toastHas(t, blockMessage.slice(0, 20)))
  t.ok('选择器退回 Plan', await t.waitForText('[data-testid="mode-action"]', 'Plan'))
  t.check('宿主模式仍是 plan', await t.act('mode'), 'plan')
  t.check('会话模式仍是 plan', await t.act('sessionMode'), 'plan')
  await t.shot('blocked')

  // —— 确认计划后才切得进 Ultra ——
  await t.act('confirmPlan')
  t.ok('确认后模式变 Agent', await t.waitForText('[data-testid="mode-action"]', 'Agent'))
  await pickMode(t, 'Ultra')
  t.ok('切 Ultra 成功', await t.waitUntil(`(window.__uiEvents ?? []).includes('set-mode:ultra')`))
  t.check('宿主模式是 ultra', await t.act('mode'), 'ultra')
  t.check('会话模式是 ultra', await t.act('sessionMode'), 'ultra')
  t.ok('选择器显示 Ultra', await t.waitForText('[data-testid="mode-action"]', 'Ultra'))
  t.ok('当前模式入口带图标', (await t.js(`document.querySelectorAll('[data-testid="mode-action"] svg').length`)) > 0)

  // —— Ultra 与 Ask 互斥，不叠加 ——
  await pickMode(t, 'Ask')
  t.check('再切 Ask：宿主只有 ask', await t.act('mode'), 'ask')
  t.check('再切 Ask：会话模式只有 ask', await t.act('sessionMode'), 'ask')
  t.ok('选择器显示 Ask', await t.waitForText('[data-testid="mode-action"]', 'Ask'))
  await t.shot('modes')

  // —— 设置：Ultra 独立分组，不出现普通子代理键 ——
  t.ok('设置面板渲染', await t.waitFor(PANEL))
  t.ok('左侧有 Ultra 分类', await t.waitFor('[data-testid="set-cat-ultra"]'))
  await t.click('[data-testid="set-cat-ultra"]', 20)
  t.ok('Ultra 分组打开', await t.waitFor('[data-testid="set-field-ULTRA_SUBAGENT_MODEL"]'))
  t.ok('Ultra 模型字段拿到目录', await waitModelField(t, 'set-field-ULTRA_SUBAGENT_MODEL'))
  t.check('普通子代理的键不在 Ultra 分组里', await fieldCount(t, 'set-field-SUBAGENT_MODEL'), 0)
  t.check('没有第二套资源配置（无 SUBAGENT_MAX_*）', await fieldCount(t, 'set-field-SUBAGENT_MAX_ACTIVE'), 0)
  for (const key of ['SCOUT', 'WORKER', 'PLANNER', 'REVIEWER']) {
    t.ok(`${key} 角色模型字段在`, (await fieldCount(t, `set-field-ULTRA_SUBAGENT_MODEL_${key}`)) === 1)
  }
  t.ok('Ultra 白名单字段在', (await fieldCount(t, 'set-field-ULTRA_SUBAGENT_MODEL_ALLOWLIST')) === 1)
  t.ok('说明写清空值回退当前主模型', (await t.text(PANEL)).includes('当前主模型'))
  t.ok('说明写清 cheap → Scout / strong → Worker', (await t.text(PANEL)).includes('Scout') && (await t.text(PANEL)).includes('Worker'))

  // —— 只设 Ultra 键 ——
  await pick(t, 'set-field-ULTRA_SUBAGENT_MODEL-provider', 'Alpha')
  await pick(t, 'set-field-ULTRA_SUBAGENT_MODEL', 'deep')
  await waitSelectText(t, 'set-field-ULTRA_SUBAGENT_MODEL', 'deep')
  await pick(t, 'set-field-ULTRA_SUBAGENT_MODEL_SCOUT-provider', 'Beta')
  await pick(t, 'set-field-ULTRA_SUBAGENT_MODEL_SCOUT', 'wide')
  await waitSelectText(t, 'set-field-ULTRA_SUBAGENT_MODEL_SCOUT', 'wide')
  await pick(t, 'set-field-ULTRA_SUBAGENT_MODEL_ALLOWLIST', 'Alpha / deep')
  t.ok('白名单选中一条', (await t.js(selectText('set-field-ULTRA_SUBAGENT_MODEL_ALLOWLIST'))).includes('deep'))
  await t.key('Escape')
  await t.sleep(200)
  await t.shot('ultra-settings')

  // —— 切到普通子代理分类：Ultra 的值不进普通字段，普通字段仍是自己的值 ——
  await t.click('[data-testid="set-cat-subagent"]', 20)
  t.ok('普通子代理分类打开', await t.waitForText(PANEL, '并发与上限'))
  t.ok('普通模型字段拿到目录', await waitModelField(t, 'set-field-SUBAGENT_MODEL'))
  t.check('普通分组里没有 Ultra 键', await fieldCount(t, 'set-field-ULTRA_SUBAGENT_MODEL'), 0)
  t.ok('普通子代理模型仍是 alpha/fast', await waitSelectText(t, 'set-field-SUBAGENT_MODEL', 'fast'))
  t.ok('普通资源上限文案注明与 Ultra 共用', (await t.text(PANEL)).includes('Ultra 与普通模式共用'))
  t.ok('普通模型策略文案注明仅非 Ultra', (await t.text(PANEL)).includes('仅非 Ultra'))
  // 改普通 cheap：Ultra 键不应被改写
  await pick(t, 'set-field-SUBAGENT_MODEL_CHEAP-provider', 'Alpha')
  await pick(t, 'set-field-SUBAGENT_MODEL_CHEAP', 'fast')
  await waitSelectText(t, 'set-field-SUBAGENT_MODEL_CHEAP', 'fast')

  // —— 切回 Ultra：未保存的值没丢 ——
  await t.click('[data-testid="set-cat-ultra"]', 20)
  t.ok('切回 Ultra：默认模型仍是 alpha/deep', await waitSelectText(t, 'set-field-ULTRA_SUBAGENT_MODEL', 'deep'))
  t.ok('切回 Ultra：Scout 仍是 beta/wide', await waitSelectText(t, 'set-field-ULTRA_SUBAGENT_MODEL_SCOUT', 'wide'))

  // —— 保存：两套键各存各的 ——
  await t.click('[data-testid="set-save"]', 20)
  t.ok('保存写盘', await t.waitUntil(`(window.__uiEvents ?? []).includes('settings-save')`))
  const saved = await t.act('settings')
  t.check('Ultra 默认模型落盘', saved.ULTRA_SUBAGENT_MODEL, 'alpha/deep')
  t.check('Ultra Scout 落盘', saved.ULTRA_SUBAGENT_MODEL_SCOUT, 'beta/wide')
  t.check('Ultra 白名单落盘', saved.ULTRA_SUBAGENT_MODEL_ALLOWLIST, JSON.stringify(['alpha/deep']))
  t.check('普通模型没被 Ultra 覆盖', saved.SUBAGENT_MODEL, 'alpha/fast')
  t.check('普通 cheap 独立落盘', saved.SUBAGENT_MODEL_CHEAP, 'alpha/fast')
  t.check('没设置的角色留空，不复制普通键', saved.ULTRA_SUBAGENT_MODEL_WORKER ?? '', '')
  t.check('没设置的 Ultra 默认也不回退普通键', saved.ULTRA_SUBAGENT_MODEL_PLANNER ?? '', '')
  t.check('普通策略没被 Ultra 改写', saved.SUBAGENT_MODE, 'custom')
  await t.shot('saved')

  // —— 重新挂载设置面板：按落盘恢复，两套互不串 ——
  await t.act('remount')
  t.ok('重挂载后设置面板在', await t.waitFor(PANEL))
  await t.click('[data-testid="set-cat-ultra"]', 20)
  await waitModelField(t, 'set-field-ULTRA_SUBAGENT_MODEL')
  t.ok('恢复 Ultra 默认', await waitSelectText(t, 'set-field-ULTRA_SUBAGENT_MODEL', 'deep'))
  t.ok('恢复 Ultra Scout', await waitSelectText(t, 'set-field-ULTRA_SUBAGENT_MODEL_SCOUT', 'wide'))
  await t.click('[data-testid="set-cat-subagent"]', 20)
  await waitModelField(t, 'set-field-SUBAGENT_MODEL')
  t.ok('恢复普通子代理模型', await waitSelectText(t, 'set-field-SUBAGENT_MODEL', 'fast'))
  t.ok('恢复普通策略=选定模型', await waitSelectText(t, 'set-field-SUBAGENT_MODE', '选定模型'))

  // —— 浅色主题 ——
  await t.setTheme('light')
  await t.click('[data-testid="set-cat-ultra"]', 20)
  t.ok('浅色下 Ultra 分组仍可读', await t.waitFor('[data-testid="set-field-ULTRA_SUBAGENT_MODEL"]'))
  const panelBg = await t.style(PANEL, ['background-color'])
  t.info('浅色面板背景', panelBg)
  await t.shot('light')
}
