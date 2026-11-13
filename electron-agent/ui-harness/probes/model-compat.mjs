const options = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'
const control = (key) => `[data-testid="prov-compat-${key}-0"]`

async function choose(t, key, label) {
  const selector = control(key)
  await t.js(`document.querySelector('${selector}').scrollIntoView({ block: 'center' })`)
  await t.sleep(200)
  await t.click(selector, 20)
  t.ok(`${key} 可展开`, await t.waitFor(options))
  await t.click(`${options}[title="${label}"]`, 20)
  t.ok(`${key} 回显 ${label}`, await t.waitForText(selector, label))
}

async function open(t, provider) {
  t.ok(`${provider} 供应商可见`, await t.waitFor(`[data-testid="prov-item-${provider}"]`))
  await t.click(`[data-testid="prov-item-${provider}"]`, 20)
  t.ok('模型卡片可见', await t.waitFor('[data-testid="prov-model-expand-0"]'))
  if ((await t.text('[data-testid="prov-model-expand-0"]')).includes('展开')) {
    await t.js(`document.querySelector('[data-testid="prov-model-expand-0"]').scrollIntoView({ block: 'center' })`)
    await t.sleep(200)
    await t.click('[data-testid="prov-model-expand-0"]', 20)
  }
  t.ok('兼容设置分组已挂载', await t.waitFor('[data-testid="prov-model-card-0"] .ant-collapse-header'))
  for (const title of provider === 'messages' ? ['Anthropic 协议专用'] : ['消息、角色与工具', '缓存与会话亲和']) {
    const state = await t.js(`(() => { const headers = [...document.querySelectorAll('[data-testid="prov-model-card-0"] .ant-collapse-header')]; const index = headers.findIndex(el => el.textContent.startsWith('${title}')); return { index, expanded: headers[index]?.getAttribute('aria-expanded') }; })()`)
    if (state.index >= 0 && state.expanded !== 'true') {
      const selector = `[data-testid="prov-model-card-0"] .ant-collapse-item:nth-child(${state.index + 1}) .ant-collapse-header`
      await t.js(`document.querySelector('${selector}').scrollIntoView({ block: 'center' })`)
      await t.sleep(200)
      await t.click(selector, 20)
    }
  }
}

async function remount(t) {
  const previous = await t.js(`Number(document.querySelector('[data-testid="model-compat-root"]').dataset.revision)`)
  await t.act('remount')
  t.ok('设置页已重挂载', await t.waitUntil(`Number(document.querySelector('[data-testid="model-compat-root"]').dataset.revision) > ${previous}`))
}

async function save(t) {
  const previous = (await t.events()).filter((event) => event === 'save').length
  await t.click('[data-testid="prov-save"]', 20)
  t.ok('保存写入模型配置', await t.waitUntil(`(window.__uiEvents ?? []).filter(e => e === 'save').length > ${previous}`))
  return JSON.parse((await t.data()).savedModelsJson).providers
}

export default async function (t) {
  await open(t, 'relay')
  t.ok('未设置的布尔兼容项显示跟随 SDK', await t.waitForText(control('requiresToolsWithToolHistory'), '跟随 SDK'))
  await choose(t, 'requiresNonNullAssistantContent', '开启')
  await choose(t, 'requiresToolsWithToolHistory', '关闭')
  await choose(t, 'promptCacheKeyMode', '启用')
  let saved = await save(t)
  t.check('OpenAI 兼容字段真实落盘，false 不丢失', saved.relay.models[0].compat, {
    requiresNonNullAssistantContent: true, requiresToolsWithToolHistory: false, promptCacheKeyMode: 'enabled',
  })
  await remount(t)
  await open(t, 'relay')
  t.ok('重挂后恢复显式关闭', await t.waitForText(control('requiresToolsWithToolHistory'), '关闭'))
  t.ok('重挂后恢复缓存键', await t.waitForText(control('promptCacheKeyMode'), '启用'))
  await choose(t, 'requiresToolsWithToolHistory', '跟随 SDK（默认关闭）')
  saved = await save(t)
  t.ok('回到 SDK 默认会删除覆盖，而不是写 false', !Object.hasOwn(saved.relay.models[0].compat, 'requiresToolsWithToolHistory'))

  await open(t, 'messages')
  t.check('Anthropic 不显示 OpenAI 缓存键字段', await t.count(control('promptCacheKeyMode')), 0)
  await choose(t, 'supportsMessageThreads', '关闭')
  saved = await save(t)
  t.check('消息线程可显式关闭', saved.messages.models[0].compat.supportsMessageThreads, false)
  await remount(t)
  await open(t, 'messages')
  t.ok('消息线程关闭状态恢复', await t.waitForText(control('supportsMessageThreads'), '关闭'))
  await choose(t, 'supportsMessageThreads', '开启')
  await t.js(`document.querySelector('${control('supportsMessageThreads')}').scrollIntoView({ block: 'center' })`)
  await t.shot('threads-dark')
  await choose(t, 'supportsMessageThreads', '跟随 SDK（按端点判断）')
  saved = await save(t)
  t.ok('消息线程可恢复自动端点检测', !Object.hasOwn(saved.messages.models[0].compat ?? {}, 'supportsMessageThreads'))

  await open(t, 'responses')
  t.check('Responses 不显示 Chat Completions 工具历史字段', await t.count(control('requiresToolsWithToolHistory')), 0)
  await choose(t, 'promptCacheKeyMode', '禁用')
  saved = await save(t)
  t.check('Responses 可禁用缓存键', saved.responses.models[0].compat.promptCacheKeyMode, 'disabled')
  await t.setTheme('light')
  await t.js(`document.querySelector('${control('promptCacheKeyMode')}').scrollIntoView({ block: 'center' })`)
  await t.shot('cache-light')
  const before = await t.resize(1000, 740)
  await t.js(`document.querySelector('${control('promptCacheKeyMode')}').scrollIntoView({ block: 'center' })`)
  const geometry = await t.js(`(() => { const r = document.querySelector('${control('promptCacheKeyMode')}').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, screen: innerWidth }; })()`)
  t.ok('窄屏缓存控制完整可见', geometry.left >= 0 && geometry.right <= geometry.screen && geometry.width >= 100)
  await t.shot('cache-narrow')
  await t.resize(before[0], before[1])
}
