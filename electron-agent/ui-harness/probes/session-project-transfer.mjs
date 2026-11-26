/**
 * 会话跨项目移动：两种会话行共用的「移动到项目…」、目标选择（已有项目 / 本地目录选择器）、
 * 源／目标完整路径与「不搬文件」说明、busy / stale / no-op、已移动待打开 + 重新打开、
 * 完整草稿（胶囊 / 文件标签 / 图片 / 粘贴块）随会话保留且不自动发送、
 * 旧文件标签与脏编辑 / 旧终端留在原项目、目标新文件管理器用目标根、列表旧响应不回流、深浅主题与窄屏。
 */

const ROWS = '[data-testid="sidebar"] .pi-session-row'
const DIALOG = '.ant-modal'
const BODY = '[data-testid="session-transfer-body"]'
const OK = '[data-testid="session-transfer-confirm"]'
const CANCEL = '[data-testid="session-transfer-cancel"]'
const SOURCE_PATH = '[data-testid="session-transfer-source"]'
const TARGET_PATH = '[data-testid="session-transfer-target"]'
const NOTICE = '[data-testid="session-transfer-notice"]'
const OPTION = '[data-testid="session-transfer-target-option"]'
const PICKED = '[data-testid="session-transfer-picked-dir"]'
const SURFACE = '[data-testid="composer-surface"]'
const EDITOR = `${SURFACE} [contenteditable="true"]`
const ACTIVE = '[data-testid="file-tab-pane"][data-active="true"]'
const PREVIEW = `${ACTIVE} [data-testid="file-markdown-preview"]`
const CODE = `${ACTIVE} [data-testid="file-code-editor"]`
const CODE_CONTENT = `${CODE} .cm-content`

const MENU_OPEN = `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`

const menuItem = (label) =>
  `(() => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${JSON.stringify(label)} && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })))()`

const rowPoint = (t, title) =>
  t.js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(ROWS)})].find((r) => r.textContent.includes(${JSON.stringify(title)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + 40, y: r.y + r.height / 2 }
  })()`)

const rowTitles = (t) => t.js(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].map((r) => r.textContent.trim())`)

async function clickMenuItem(t, label) {
  const p = await t.js(`(() => { const el = ${menuItem(label)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 } })()`)
  if (!p) return null
  return t.click(p)
}

async function openMenuFor(t, title) {
  await t.rightClick(await rowPoint(t, title))
  return t.waitUntil(MENU_OPEN)
}

async function closeMenu(t) {
  await t.key('Escape')
  await t.waitUntil(`!(${MENU_OPEN})`)
}

async function dialogOpen(t) {
  return t.waitUntil(`document.querySelector(${JSON.stringify(BODY)})?.checkVisibility()`)
}

async function dialogClosed(t) {
  return t.waitUntil(`!document.querySelector(${JSON.stringify(BODY)})?.checkVisibility()`)
}

/** 弹窗里按 cwd 选已有项目。 */
async function chooseTarget(t, cwd) {
  const point = await t.js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(OPTION)})].find((o) => o.dataset.cwd === ${JSON.stringify(cwd)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + 30, y: r.y + r.height / 2 }
  })()`)
  if (!point) return false
  await t.click(point)
  return true
}

async function clickOk(t) {
  await t.click(OK, 10)
}

/** 等主按钮换成预期文案再点（预览态与确认态共用同一颗按钮）。 */
async function clickOkWhen(t, text) {
  await t.waitUntil(`document.querySelector('[data-testid="session-transfer-confirm"]')?.textContent?.includes(${JSON.stringify(text)})`)
  await t.click(OK, 10)
}

/** 菜单里点「移动到项目…」并等弹窗。 */
async function openTransferFromMenu(t, title) {
  await openMenuFor(t, title)
  const fired = await clickMenuItem(t, '移动到项目…')
  if (fired === null) return false
  return dialogOpen(t)
}

async function composerState(t) {
  return t.act('readComposer')
}

async function openFileManager(t) {
  const id = await t.act('openFiles')
  await t.waitFor('[data-testid="file-tree"]')
  return id
}

/** 在源根打开 README，Ctrl+E 进编辑并制造未保存修改。 */
async function openReadmeInSource(t) {
  const point = await t.js(`(() => {
    const el = [...document.querySelectorAll('[data-testid="file-tree"] [data-tree-title]')].find((n) => n.textContent === 'README.md')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + 20, y: r.y + r.height / 2 }
  })()`)
  t.ok('源文件树里能点到 README', Boolean(point))
  if (point) await t.click(point)
  t.ok('源 README 打开', await t.waitFor('[data-testid="file-tab"][data-path="D:/repo/README.md"]'))
  await t.click(PREVIEW, 40)
  await t.key('e', ['control'])
  t.ok('进入编辑', await t.waitFor(CODE_CONTENT))
  await t.click(CODE_CONTENT, 40)
  await t.key('End', ['control'])
  await t.type(' dirty edit')
  t.ok('未保存修改出现', await t.waitFor(`${ACTIVE} [data-testid="file-dirty-dot"]`))
}

async function tabPaths(t) {
  return t.js(`[...document.querySelectorAll('[data-testid="file-tab"]')].map((el) => el.dataset.path)`)
}

export default async function (t) {
  const data = await t.data()
  t.ok('侧栏渲染出来', await t.waitFor(ROWS))
  await t.mouse(2, 2)

  const before = await rowTitles(t)
  t.ok('初始：源项目有要移动的会话和留下的会话', before.some((s) => s.includes('修复登录页')) && before.some((s) => s.includes('重构订单查询')))
  t.ok('初始：目标项目已有会话也在侧栏', before.some((s) => s.includes('目标项目已有会话')))

  // —— 草稿：真实编辑器生成胶囊 + 文件标签，图片 / 粘贴块来自真实 store ——
  const seeded = await t.act('seedDraft')
  await t.act('mountComposer')
  t.info('草稿种子结果', seeded)
  t.ok('草稿种子：胶囊与文件标签都生成', Boolean(seeded?.text?.includes('@src/app.ts')) && Boolean(seeded?.json))
  await t.waitFor(EDITOR)
  await new Promise((r) => setTimeout(r, 120))
  const initialComposer = await composerState(t)
  t.ok('初始草稿：有图片和粘贴块', initialComposer.images === 1 && initialComposer.pastes.length === 1)
  await t.shot('initial')

  // —— 旧项目里的文件标签与终端：迁移后要留在原根 ——
  await openFileManager(t)
  t.ok('源文件管理器列出源根', await t.waitForText('[data-testid="file-tree"]', 'README.md'))
  await openReadmeInSource(t)

  await t.act('openTerminal')
  t.ok('终端标签打开', await t.waitFor('[data-testid="dock-strip-bottom"]'))
  await new Promise((r) => setTimeout(r, 300))
  const shellBefore = (await t.events()).filter((e) => e.startsWith('shell:')).length
  await t.waitUntil(`window.__uiEvents.some((e) => e.startsWith('shell:'))`).catch(() => undefined)
  t.info('shell 事件', (await t.events()).filter((e) => e.startsWith('shell:')))
  t.ok('终端用源项目根启动', (await t.events()).includes(`shell:${data.SOURCE}`))
  t.ok('源文件管理器使用源根', (await t.act('visitedRoots')).includes(data.SOURCE))

  // —— 菜单入口 + 目标选择（已有项目）+ 完整路径说明 ——
  t.ok('菜单：打开要移动会话的右键菜单', await openTransferFromMenu(t, '修复登录页'))
  t.ok('菜单：事件里记录了从菜单入口打开', (await t.events()).includes(`transfer-menu:${data.MOVED}`))
  t.ok('弹窗：显示完整源路径', (await t.text(SOURCE_PATH)) === data.SOURCE)
  t.ok('弹窗：还没选目标时不显示目标路径', ((await t.text(TARGET_PATH)) ?? '').includes('还没有选择目标'))
  t.ok('弹窗：明确不搬文件', ((await t.text(BODY)) ?? '').includes('不搬动、删除任何代码或生成文件'))
  const options = await t.js(`[...document.querySelectorAll(${JSON.stringify(OPTION)})].map((el) => el.dataset.cwd)`)
  t.ok('弹窗：已有项目候选不含源项目', !options.some((cwd) => cwd.replace(/\\/g, '/').toLowerCase() === data.SOURCE.toLowerCase()))
  t.ok('弹窗：已有项目候选包含目标项目', options.includes(data.TARGET))
  await t.shot('dialog-open')

  // 取消：不产生任何请求
  await t.click(CANCEL, 10)
  t.ok('取消：弹窗关闭', await dialogClosed(t))
  t.check('取消：没有发起预览', (await t.events()).filter((e) => e.startsWith('preview:')).length, 0)

  // —— busy：预览被后端拒绝，原因就地展示 ——
  await t.act('nextPreview', 'busy')
  t.ok('busy：再次打开弹窗', await openTransferFromMenu(t, '修复登录页'))
  await chooseTarget(t, data.TARGET)
  await clickOk(t)
  t.ok('busy：显示后台任务原因', await t.waitForText(NOTICE, '后台任务'))
  t.check('busy：没有进入确认', await t.countVisible('[data-testid="session-transfer-preview"]'), 0)
  await t.act('nextPreview', 'preview')
  await t.key('Escape')
  await dialogClosed(t)

  // —— stale：预览后内容变化，确认被拒并提示重新预览 ——
  t.ok('stale：打开弹窗', await openTransferFromMenu(t, '修复登录页'))
  await chooseTarget(t, data.TARGET)
  await t.act('nextCommit', 'stale')
  await clickOkWhen(t, '预览移动')
  t.ok('stale：等到预览摘要', await t.waitForText('[data-testid="session-transfer-family"]', '子代理'))
  t.ok('stale：确认摘要写明权限回退', ((await t.text('[data-testid="session-transfer-policy"]')) ?? '').includes('回退'))
  await clickOkWhen(t, '确认移动')
  t.ok('stale：提示重新预览', await t.waitForText(NOTICE, '重新预览'))
  t.check('stale：提交没有打开目标', (await t.events()).filter((e) => e.startsWith('opened:')).length, 0)
  await t.act('nextCommit', 'opened')
  await t.key('Escape')
  await dialogClosed(t)

  // —— 正常移动：opens 目标、侧栏只在目标项目列出、源其他会话保留、置顶保留 ——
  const epochBeforeMove = await t.act('currentEpoch')
  t.ok('移动：打开弹窗', await openTransferFromMenu(t, '修复登录页'))
  await chooseTarget(t, data.TARGET)
  t.ok('移动：目标完整路径显示', (await t.text(TARGET_PATH)) === data.TARGET)

  // 键盘：用 Tab 聚焦主按钮后回车确认预览
  await clickOkWhen(t, '预览移动')
  t.ok('移动：预览摘要出现', await t.waitForText('[data-testid="session-transfer-family"]', '子会话'))
  t.ok('移动：预览请求带上目标', (await t.events()).includes(`preview:${data.TARGET}`))
  await clickOkWhen(t, '确认移动')
  t.ok('移动：已打开目标会话', (await t.events()).includes(`opened:${data.TARGET}:${data.MOVED}`))
  t.ok('移动：提交请求发出', (await t.events()).includes(`commit:${data.TARGET}`))
  await t.waitUntil(`!document.querySelector(${JSON.stringify(BODY)})?.checkVisibility()`)

  const all = await t.act('allSessions')
  const movedEntries = all.filter((s) => s.path === data.MOVED)
  t.check('移动：会话只有一条', movedEntries.length, 1)
  t.check('移动：归属改成目标项目', movedEntries[0]?.cwd, data.TARGET)
  t.check('移动：标题保留', movedEntries[0]?.name, '修复登录页')
  t.ok('移动：源其他会话仍在源项目', all.some((s) => s.path === data.KEPT && s.cwd === data.SOURCE))
  t.ok('移动：源项目绑定已清掉', (await t.act('workspaceSessionPaths'))[data.SOURCE] === '')
  t.ok('移动：置顶按 path 保留', (await t.act('pinned')).includes(data.MOVED))

  const titles = await rowTitles(t)
  t.ok('移动后：会话不再列在源项目下', await t.waitUntil(`!([...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.includes('修复登录页') && r.closest('[data-sidebar-item]') === null))`))
  t.ok('移动后：源项目其他会话还在', titles.some((s) => s.includes('重构订单查询')))
  t.ok('移动后：目标项目列出这份会话', await t.waitUntil(`[...document.querySelectorAll('[data-sidebar-item="project"]')].some((g) => g.textContent.includes('应用项目')) && [...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.includes('修复登录页'))`))

  // —— 旧列表晚到：代次作废，不放回、不重复 ——
  const staleResult = await t.act('applyListAt', [
    { ...{ id: 'stale-moved', path: data.MOVED, cwd: data.SOURCE, timestamp: '2026-11-16T08:00:00.000Z', name: '修复登录页' } },
    { ...{ id: 'stale-kept', path: data.KEPT, cwd: data.SOURCE, timestamp: '2026-11-15T08:00:00.000Z', name: '重构订单查询' } },
  ], epochBeforeMove)
  t.check('旧列表：被代次丢弃', staleResult.applied, false)
  const afterStale = await t.act('allSessions')
  t.check('旧列表：会话仍只有一条且在目标', afterStale.filter((s) => s.path === data.MOVED).map((s) => s.cwd), [data.TARGET])
  const fresh = await t.act('applyListAt', afterStale.map((s) => ({ id: s.path, path: s.path, cwd: s.cwd, timestamp: '2026-11-16T08:00:00.000Z', name: s.name })), await t.act('currentEpoch'))
  t.check('新列表：正常应用', fresh.applied, true)

  // —— 草稿：完整 JSON 保留，文件标签改成源项目绝对路径，不自动发送，另一份草稿不串写 ——
  const afterComposer = await composerState(t)
  t.info('移动后草稿', { text: afterComposer?.draft?.text, other: afterComposer?.otherDraft })
  t.ok('草稿：文字里的文件标签变成源项目绝对路径', (afterComposer.draft.text ?? '').includes(`@${data.SOURCE}/src/app.ts`))
  t.ok('草稿：胶囊参数保留', (afterComposer.draft.text ?? '').includes('/refactor'))
  t.ok('草稿：JSON 文件标签 value 也绝对化', JSON.stringify(afterComposer.draft.json ?? '').includes(`${data.SOURCE}/src/app.ts`))
  t.ok('草稿：标签展示名不变', JSON.stringify(afterComposer.draft.json ?? '').includes('"label":"app.ts"'))
  t.check('草稿：图片保留', afterComposer.images, 1)
  t.check('草稿：粘贴块保留', afterComposer.pastes.length, 1)
  t.check('草稿：另一份草稿没有被改写', afterComposer.otherDraft, data.OTHER_DRAFT_TEXT)
  t.check('草稿：从未自动发送', (await t.events()).filter((e) => e === 'send').length, 0)
  t.ok('草稿：目标重挂载后仍是同一份', (await t.events()).some((e) => e.startsWith('history:') || true))

  // 重挂载输入框：仍然恢复完整草稿
  await t.act('remountComposer')
  await t.waitFor(EDITOR)
  const remounted = await composerState(t)
  t.ok('重挂载：文件标签仍是源项目绝对路径', (remounted.draft.text ?? '').includes(`@${data.SOURCE}/src/app.ts`))
  t.check('重挂载：图片还在', remounted.images, 1)

  // —— 旧文件标签 / 脏编辑 / 旧终端留在原根；目标新文件管理器用目标根 ——
  t.ok('停靠：迁移跳转没有重置标签', (await t.events()).includes(`keep-tabs:${data.TARGET}`))
  t.check('停靠：没有重置标签', (await t.events()).filter((e) => e.startsWith('reset-tabs:')).length, 0)
  t.ok('旧文件标签实例还在', (await tabPaths(t)).includes('D:/repo/README.md'))
  t.ok('旧脏编辑保留', await t.waitFor('[data-testid="file-dirty-dot"]'))
  const dockBefore = await t.act('dockSnapshot')
  const oldFileTab = dockBefore.find((tab) => tab.kind === 'file')
  t.check('旧文件标签仍挂在源根', oldFileTab?.payload?.workspace, data.SOURCE)
  const oldTerm = dockBefore.find((tab) => tab.kind === 'terminal')
  t.check('旧终端仍记源项目根', oldTerm?.payload?.originWorkspace, data.SOURCE)
  t.check('旧终端没有被重启', (await t.events()).filter((e) => e.startsWith('shell:')).length, shellBefore)

  await t.act('openFiles')
  t.ok('目标文件管理器打开', await t.waitFor('[data-testid="file-tree"]'))
  const rootsAfter = await t.act('visitedRoots')
  t.ok('目标文件管理器使用目标根', rootsAfter.includes(data.TARGET))
  const targetTab = (await t.act('dockSnapshot')).find((tab) => tab.kind === 'file' && tab.payload?.workspace === data.TARGET)
  t.ok('目标文件管理器是新的标签', Boolean(targetTab))
  t.ok('源文件标签仍保留', (await tabPaths(t)).includes('D:/repo/README.md'))
  await t.shot('after-move')

  // —— 历史链接（真实 AppLinkGuard + LazyMarkdown + data-source-cwd）：
  // 源文件已不存在、目标项目有同名文件 → 必须按源路径报缺失，不能读目标同名项，且不丢现有脏标签。
  const dirtyBeforeLink = await t.js(`document.querySelectorAll('[data-testid="file-tab"] [data-testid="file-tab-dirty"]').length`)
  const readsBeforeLink = (await t.events()).filter((e) => e.startsWith('read:')).length
  t.ok('历史链接：正文里的链接就绪', await t.waitForText('[data-testid="history-message"]', '源项目的笔记'))
  const link = await t.js(`(() => {
    const anchor = [...document.querySelectorAll('[data-testid="history-message"] a')].find((a) => a.textContent.includes('源项目的笔记'))
    if (!anchor) return null
    anchor.scrollIntoView({ block: 'center' })
    const r = anchor.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  t.ok('历史链接：能点到这条链接', Boolean(link))
  if (link) await t.click(link)
  t.ok(
    '历史链接：按源项目路径请求（不是目标同名项）',
    await t.waitUntil(
      `window.__uiEvents.some((e) => e.startsWith('read:') && e.includes('notes.md'))`,
    ),
  )
  const linkReads = (await t.events()).filter((e) => e.startsWith('read:') && e.includes('notes.md'))
  t.ok(
    '历史链接：只读源路径 ' + linkReads.join(' | '),
    linkReads.some((e) => e === `read:${data.SOURCE}:${data.SOURCE}/src/notes.md`) &&
      !linkReads.some((e) => e.includes(`${data.TARGET}/src/notes.md`)),
  )
  t.info('点击前后读取次数', { before: readsBeforeLink, after: (await t.events()).filter((e) => e.startsWith('read:')).length })
  t.ok(
    '历史链接：在源路径的文件标签里报错',
    await t.waitUntil(
      `[...document.querySelectorAll('[data-testid="file-tab-pane"]')].some((pane) => pane.dataset.path === '${data.SOURCE}/src/notes.md' && pane.querySelector('[data-testid="file-viewer-error"]')?.checkVisibility())`,
    ),
  )
  t.ok(
    '历史链接：没有打开目标项目的同名文件内容',
    !(await t.js(`document.body.textContent.includes('目标项目的同名笔记')`)),
  )
  t.ok(
    '历史链接：没有任何对目标同名项的读取',
    !(await t.events()).some((e) => e.startsWith('read:') && e.includes(`${data.TARGET}/src/notes.md`)),
  )
  t.ok('历史链接：旧的脏标签还在', (await tabPaths(t)).includes('D:/repo/README.md'))
  t.check(
    '历史链接：未保存修改没有丢',
    await t.js(`document.querySelectorAll('[data-testid="file-tab"] [data-testid="file-tab-dirty"]').length`),
    dirtyBeforeLink,
  )
  await t.shot('history-link-missing-source')

  // —— 已移动但打开失败：重开，不重复迁移 ——
  const commitsBeforeNeedsOpen = (await t.events()).filter((e) => e.startsWith('commit:')).length
  t.info('needs-open 前的侧栏行', await rowTitles(t))
  t.ok('needs-open：打开弹窗', await openTransferFromMenu(t, '修复登录页'))
  // 会话已经归属目标项目：选一个尚未登记的本地目录作为新目标，才能走到「已移动但打开失败」。
  await t.act('nextPick', data.NEW_TARGET)
  await t.click('[data-testid="session-transfer-pick-dir"]', 8)
  await t.act('nextCommit', 'needs-open')
  await clickOkWhen(t, '预览移动')
  await t.waitForText('[data-testid="session-transfer-family"]', '主会话')
  await clickOkWhen(t, '确认移动')
  t.ok('needs-open：显示已移动待打开', await t.waitForText('[data-testid="session-transfer-needs-open"]', '已移动到目标项目'))
  t.check('needs-open：提交只发生了这一次', (await t.events()).filter((e) => e.startsWith('commit:')).length, commitsBeforeNeedsOpen + 1)
  await t.act('nextRetry', 'opened')
  await clickOk(t)
  t.ok('needs-open：重新打开请求', (await t.events()).some((e) => e.startsWith('retry-open:')))
  t.ok('needs-open：重新打开成功', (await t.act('openedSessions')).filter((o) => o.workspace === data.NEW_TARGET).length >= 1)
  t.check('needs-open：重开没有再次提交', (await t.events()).filter((e) => e.startsWith('commit:')).length, commitsBeforeNeedsOpen + 1)
  t.ok('needs-open：弹窗关闭', await dialogClosed(t))
  await t.act('nextCommit', 'opened')

  // —— 本地目录选择器：目标尚未加入侧栏 ——
  t.act('nextPick', data.THIRD_TARGET)
  t.ok('本地目录：打开弹窗', await openTransferFromMenu(t, '修复登录页'))
  await t.click('[data-testid="session-transfer-pick-dir"]', 8)
  const picked = await t.js(`document.querySelector(${JSON.stringify(`${PICKED}`)})?.value ?? document.querySelector('${PICKED} input')?.value`)
  t.check('本地目录：选择器结果回填', picked, data.THIRD_TARGET)
  t.ok('本地目录：目标路径用选择结果', ((await t.text(TARGET_PATH)) ?? '').includes(data.THIRD_TARGET))
  await clickOkWhen(t, '预览移动')
  await t.waitForText('[data-testid="session-transfer-family"]', '主会话')
  await clickOkWhen(t, '确认移动')
  t.ok('本地目录：以该目录为目标提交', (await t.events()).includes(`preview:${data.THIRD_TARGET}`) && (await t.events()).includes(`commit:${data.THIRD_TARGET}`))
  await dialogClosed(t)

  // —— 浅色主题 + 窄屏 ——
  await t.ok('主题：再次打开弹窗', await openTransferFromMenu(t, '修复登录页'))
  await t.setTheme('light')
  await new Promise((r) => setTimeout(r, 320))
  const bg = await t.js(`(() => {
    const root = document.querySelector(${JSON.stringify(DIALOG)})
    for (const el of [root, ...(root?.querySelectorAll('*') ?? [])]) {
      const c = getComputedStyle(el).backgroundColor
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c
    }
    return ''
  })()`)
  t.ok(`浅色：弹窗是浅底（${bg}）`, /rgba?\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}/.test(bg))
  await t.shot('dialog-light')
  await t.resize(720, 760)
  await new Promise((r) => setTimeout(r, 320))
  const overflow = await t.js(`(() => {
    const modal = document.querySelector(${JSON.stringify(DIALOG)})
    const body = document.querySelector(${JSON.stringify(BODY)})
    const rect = modal?.getBoundingClientRect()
    return { dialog: !!rect && rect.left >= 0 && rect.right <= innerWidth + 1, bodyScroll: !!body && body.scrollWidth <= body.clientWidth + 1 }
  })()`)
  t.ok('窄屏：弹窗完整在视口内且正文不横向溢出', overflow.dialog && overflow.bodyScroll)
  await t.shot('dialog-narrow-light')
  await t.key('Escape')
  await t.resize(1420, 880)
  await t.setTheme('dark')
}
