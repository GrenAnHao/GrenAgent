/**
 * Plan 侧栏：模型 upsert_plan 推来计划后右栏自动开「计划」标签；步骤全文不截断；就地改步骤（改字、下移、加一步）后
 * 保存走 /plan-update（同一 planId、带基准 rev、步骤全文），回来是第 2 版 · 已手动修改；未保存时「确认执行」不可点并写原因；
 * 模型在用户改的时候修订 → 冲突提示，「载入最新」换成新版本；未确认时手切 Agent 被宿主取消，选择器退回 Plan 并提示去侧栏确认；
 * 点「确认执行」发 /plan-confirm <id> <rev>，模式变 Agent、面板只读并显示进度，[DONE:n] 推进度，「标记完成」进已完成；
 * 摘要卡只有「打开计划面板」，状态跟着变，新计划出来后旧卡写「已被新的计划取代」；取消计划要二次确认；浅色主题。
 */

const PANEL = '[data-testid="plan-panel"]'
const STEP = (i) => `[data-testid="plan-step"][data-index="${i}"]`
const STEP_INPUTS = '[data-testid="plan-step-input"]'
const SAVE = '[data-testid="plan-save"]'
const CONFIRM = '[data-testid="plan-confirm"]'
const CARD = '[data-testid="plan-summary-card"]'

const stepValues = (t) => t.js(`[...document.querySelectorAll('${STEP_INPUTS}')].map((el) => el.value)`)
const disabled = (t, sel) => t.js(`!!document.querySelector('${sel}')?.disabled`)
const toastHas = (t, text) =>
  t.waitUntil(`[...document.querySelectorAll('.ant-message-notice')].some((el) => el.textContent.includes(${JSON.stringify(text)}))`)

async function focusEnd(t, sel) {
  await t.js(`document.querySelector('${sel}')?.scrollIntoView({ block: 'center' })`)
  await t.click(sel, 20)
  await t.key('End', ['control'])
}

export default async function (t) {
  const { longStep, blockMessage, session } = await t.data()
  t.ok('输入栏模式选择器渲染出来', await t.waitFor('[data-testid="mode-action"]'))
  t.check('还没有计划：右栏没有标签', await t.count(PANEL), 0)

  // —— 模型第一次 upsert_plan：自动打开侧栏 ——
  await t.act('created', 'plan-a', '重构鉴权层')
  t.ok('created：右栏自动打开计划面板', await t.waitFor(PANEL))
  t.check('计划面板在可见的右栏里', await t.countVisible(PANEL), 1)
  t.ok('状态是「待确认」', await t.waitForText('[data-testid="plan-status"]', '待确认'))
  t.ok('版本写第 1 版', (await t.text('[data-testid="plan-rev"]')).includes('第 1 版'))
  t.ok('摘要卡出现在对话流', await t.waitFor(CARD))
  t.ok('摘要卡写标题与状态', (await t.text(CARD)).includes('重构鉴权层') && (await t.text(CARD)).includes('待确认'))
  t.check('摘要卡上没有「开始执行」', (await t.text(CARD)).includes('开始执行'), false)
  const initial = await stepValues(t)
  t.check('步骤全文进编辑框，没有 50 字截断', initial[1], longStep)
  t.ok('长步骤超过 50 字', longStep.length > 50)
  t.check('没改动时保存不可点', await disabled(t, SAVE), true)
  t.check('待确认且没改动：确认执行可点', await disabled(t, CONFIRM), false)
  await t.shot('created')

  // —— 就地编辑：改字、下移、加一步 ——
  await focusEnd(t, `${STEP(0)} textarea`)
  await t.insertText('（含 ws 路由）')
  await t.click(`${STEP(0)} [data-testid="plan-step-down"]`, 12)
  await t.click('[data-testid="plan-add-step"]', 20)
  await t.waitUntil(`document.querySelectorAll('${STEP_INPUTS}').length === 4`)
  await focusEnd(t, `${STEP(3)} textarea`)
  await t.insertText('更新 docs/auth.md')
  const edited = await stepValues(t)
  t.check('编辑后：顺序和文字跟着变', edited, [longStep, '梳理现有 /api 路由的鉴权写法（含 ws 路由）', '补集成测试：未登录 401、无权限 403', '更新 docs/auth.md'])
  t.check('有改动：保存可点', await disabled(t, SAVE), false)
  t.check('有改动：确认执行不可点', await disabled(t, CONFIRM), true)
  t.ok('确认不可点时写明原因', (await t.text('[data-testid="plan-confirm-hint"]')).includes('先保存'))
  await t.shot('editing')

  // —— 保存：/plan-update 带同一 planId、基准 rev 与全文步骤 ——
  await t.click(SAVE, 20)
  t.ok('保存后变成第 2 版 · 已手动修改', await t.waitForText('[data-testid="plan-rev"]', '第 2 版 · 已手动修改'))
  const events = await t.events()
  const update = events.find((e) => e.startsWith('update:'))
  const payload = update ? JSON.parse(update.slice('update:'.length)) : null
  t.check('plan-update 带同一个 planId', payload?.planId, 'plan-a')
  t.check('plan-update 带基准 rev', payload?.rev, 1)
  t.check('plan-update 带全文步骤', payload?.steps?.map((s) => s.text), edited)
  t.ok('命令打到计划所属的会话', events.includes(`prompt-target:${session}`))
  t.check('读回与侧栏一致', (await t.act('plan')).steps.map((s) => s.text), edited)
  t.check('保存后没有未保存改动：确认执行可点', await disabled(t, CONFIRM), false)
  t.check('保存后保存按钮回到不可点', await disabled(t, SAVE), true)

  // —— 用户改着、模型同 id 修订：冲突提示，载入最新 ——
  await focusEnd(t, `${STEP(2)} textarea`)
  await t.insertText('（补）')
  await t.act('modelRevise')
  t.ok('冲突：提示计划已更新', await t.waitFor('[data-testid="plan-conflict"]'))
  t.ok('冲突提示写新版本号', (await t.text('[data-testid="plan-conflict"]')).includes('第 3 版'))
  t.check('冲突时本地修改保留', (await stepValues(t))[2], '补集成测试：未登录 401、无权限 403（补）')
  await t.click('[data-testid="plan-reload"]', 12)
  t.ok('载入最新后冲突提示消失', await t.waitUntil(`!document.querySelector('[data-testid="plan-conflict"]')`))
  t.check('载入最新后是模型的版本', (await stepValues(t))[2], '补集成测试：未登录 401、无权限 403')
  t.ok('标题换成模型修订的', (await t.js(`document.querySelector('[data-testid="plan-title-input"]')?.value`)).includes('模型修订'))

  // —— 未确认时手切 Agent：宿主取消切换，选择器退回 Plan，提示去侧栏确认 ——
  await t.click('[data-testid="mode-action"] [role="combobox"]', 12)
  t.ok('模式下拉打开', await t.waitUntil(`[...document.querySelectorAll('[role="option"]')].some((el) => el.textContent.trim() === 'Agent')`))
  await t.js(`(() => { const el = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Agent'); el?.setAttribute('data-probe', 'agent-option') })()`)
  await t.click('[data-probe="agent-option"]', 12)
  t.ok('手切 Agent 发给了宿主', (await t.events()).includes('set-mode:agent'))
  t.ok('提示指向侧栏确认执行', await toastHas(t, '确认执行'))
  t.ok('提示是宿主给的原文', await toastHas(t, blockMessage.slice(0, 20)))
  t.ok('选择器退回 Plan', await t.waitForText('[data-testid="mode-action"]', 'Plan'))
  t.check('桩里模式仍是 plan', await t.act('mode'), 'plan')
  await t.shot('blocked')

  // —— 确认执行：一次点击 → Agent + 执行中 ——
  await t.click(CONFIRM, 20)
  t.ok('确认命令带 id 与版本', await t.waitUntil(`(window.__uiEvents ?? []).includes('confirm:plan-a:3')`))
  t.ok('确认后状态「执行中」', await t.waitForText('[data-testid="plan-status"]', '执行中'))
  t.ok('确认后模式选择器是 Agent', await t.waitForText('[data-testid="mode-action"]', 'Agent'))
  t.check('执行中：面板只读，没有编辑框', await t.count(STEP_INPUTS), 0)
  t.ok('执行中：长步骤全文显示', (await t.texts('[data-testid="plan-read-step"]')).some((s) => s.includes(longStep)))
  t.ok('执行中：进度 0/4（含用户加的一步）', await t.waitForText('[data-testid="plan-progress"]', '已完成 0/4'))
  t.ok('摘要卡跟着变「执行中」', await t.waitForText(CARD, '执行中'))
  await t.act('doneStep', 1)
  t.ok('[DONE:1] 后进度 1/4', await t.waitForText('[data-testid="plan-progress"]', '已完成 1/4'))
  t.check('第 1 步打勾', await t.js(`document.querySelector('[data-testid="plan-read-step"]')?.dataset.done`), 'true')
  t.ok('摘要卡写进度', await t.waitForText(CARD, '已完成 1/4'))
  await t.shot('executing')
  await t.click('[data-testid="plan-finish"]', 20)
  t.ok('标记完成后「已完成」', await t.waitForText('[data-testid="plan-status"]', '已完成'))
  t.check('已完成：没有操作按钮', await t.count('[data-testid="plan-finish"], [data-testid="plan-confirm"]'), 0)

  // —— 新计划：旧摘要卡写已被取代；取消要二次确认 ——
  await t.act('created', 'plan-b', '拆分路由文件')
  t.ok('新计划进面板', await t.waitUntil(`document.querySelector('${PANEL}')?.dataset.planId === 'plan-b'`))
  t.ok('旧摘要卡写「已被新的计划取代」', await t.waitUntil(`document.querySelectorAll('${CARD}')[0]?.textContent.includes('已被新的计划取代')`))
  t.ok('旧卡的打开按钮不可点', await t.js(`!!document.querySelectorAll('[data-testid="plan-summary-open"]')[0]?.disabled`))
  await t.click('[data-testid="plan-cancel"]', 12)
  t.ok('取消先弹二次确认', await t.waitFor('[data-testid="plan-cancel-ok"]'))
  t.ok('二次确认前没发取消', !(await t.events()).includes('cmd:plan-cancel'))
  await t.click('[data-testid="plan-cancel-ok"]', 12)
  t.ok('取消后「已取消」', await t.waitForText('[data-testid="plan-status"]', '已取消'))

  // —— 关掉面板后从摘要卡重新打开 ——
  await t.js(`document.querySelector('${PANEL}')?.closest('[data-testid="right-host"]')?.scrollIntoView()`)
  const before = await t.countVisible(PANEL)
  t.check('面板可见', before, 1)
  await t.click(`${CARD}:last-of-type [data-testid="plan-summary-open"]`, 20)
  t.check('摘要卡「打开计划面板」仍能打开当前计划', await t.countVisible(PANEL), 1)

  // —— 浅色主题 ——
  await t.setTheme('light')
  const bg = await t.style(PANEL, ['background-color'])
  t.ok(`浅色主题面板是浅底（${bg.backgroundColor}）`, /rgb\(\s*(2[3-5][0-9])/.test(bg.backgroundColor))
  await t.shot('light')
  await t.setTheme('dark')

  t.check('没有漏桩的主进程调用', (await t.events()).filter((e) => e.startsWith('unstubbed:')), [])
}
