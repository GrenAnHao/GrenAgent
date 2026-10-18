/**
 * 独立工作区（A 轨）：侧栏项目行的归属与标签、新建弹窗（fresh 默认、head 次要带风险、错误原文）、
 * 管理弹窗（状态标签、没回传的删除要二次确认并带 force、已回传的普通确认）、已删除工作区的只读查看。
 */

const ROW = (cwd) => `[data-cwd="${cwd}"] .pi-proj-row`
const MENU = (key) => `[data-menu-id$="${key}"]`
const VISIBLE_MENU = (key) => MENU(key)
const CREATE = '[data-testid="isolated-create-dialog"]'
const MANAGE = '[data-testid="isolated-manage-dialog"]'
const ENTRY = (id) => `[data-testid="isolated-entry"][data-id="${id}"]`
// antd 的 Radio / Checkbox 把 data-testid 落在隐藏的 input 上：状态读 input，可见性看包它的 label。
const checked = (id) => `document.querySelector('input[data-testid="${id}"]')?.checked ?? null`
const disabled = (id) => `document.querySelector('input[data-testid="${id}"]')?.disabled ?? null`
const LABEL = (id) => `label:has(input[data-testid="${id}"])`

/** 弹窗有开合动画，离屏渲染下截图要等动画放完，否则截到打开前的帧。 */
const settle = (t) => t.js('new Promise((resolve) => setTimeout(resolve, 450))')

export default async function (t) {
  const { W_LIVE, W_GONE, REPO } = await t.data()
  t.ok('项目行渲染出来', await t.waitFor(ROW(REPO)))

  // —— 侧栏归属 ——
  const order = await t.js(`[...document.querySelectorAll('[data-cwd]')].map((el) => el.dataset.cwd)`)
  t.check('独立工作区紧跟在父项目后面，父项目位置不变', order, ['D:/other', REPO, W_LIVE, W_GONE])
  t.check('独立工作区默认名是分支', await t.text(`${ROW(W_LIVE)} > span:nth-child(3)`), 'gren/aaa11111')
  const parentCaret = await t.rect(`${ROW(REPO)} > span:first-child`)
  const childCaret = await t.rect(`${ROW(W_LIVE)} > span:first-child`)
  t.ok('独立工作区缩进挂在父项目下', childCaret.x - parentCaret.x >= 16)
  t.ok('独立工作区带「独立」标签', (await t.text(ROW(W_LIVE))).includes('独立'))

  await t.act('probe')
  t.ok('目录已删除的标「已删除」', await t.waitUntil(`document.querySelector('[data-cwd="${W_GONE}"] [data-isolated-missing="true"]') != null`))
  t.ok('已删除的行写「已删除」', (await t.text(ROW(W_GONE))).includes('已删除'))
  await t.shot('rows')

  // —— 输入框下的工作区栏：标出独立工作区、显示父项目名、给回传按钮 ——
  t.ok('工作区栏标出独立工作区', await t.waitFor('[data-testid="workspace-isolated-chip"]'))
  t.ok('标签提示不能写主仓', (await t.js(`document.querySelector('[data-testid="workspace-isolated-chip"]').title`)).includes('不能写主仓'))
  t.check('工作区标签显示父项目名而不是 8 位 id', await t.text(`[data-testid="bar"] [title="${W_LIVE}"]`), 'repo')
  await t.click('[data-testid="workspace-isolated-sync"]', 10)
  t.ok('工作区栏的回传按钮发出 sync_back', await t.waitUntil(`(window.__uiEvents ?? []).filter((e) => e === 'sync:aaa11111').length === 1`))
  t.ok('回传成功提示写出主仓分支', await t.waitUntil(`document.body.textContent.includes('已回传：主仓分支 gren/aaa11111')`))
  await settle(t)
  await t.shot('workspace-bar')

  // —— 独立工作区自己的菜单：回传、删除，没有「在独立工作区中新建」 ——
  await t.rightClick(ROW(W_LIVE), 40)
  t.ok('独立工作区菜单有「回传分支到主仓」', await t.waitUntil(`[...document.querySelectorAll('${MENU('isolated-sync-back')}')].some((el) => el.checkVisibility())`))
  t.check('独立工作区菜单里不能再建独立工作区', await t.countVisible(MENU('isolated-new')), 0)
  await t.click(VISIBLE_MENU('isolated-sync-back'), 20)
  t.ok('点回传发出 sync_back', await t.waitUntil(`(window.__uiEvents ?? []).filter((e) => e === 'sync:aaa11111').length === 2`))
  await t.mouse(2, 2)

  // —— 普通项目菜单 → 新建弹窗 ——
  await t.rightClick(ROW(REPO), 40)
  t.ok('普通项目菜单有「在独立工作区中新建会话…」', await t.waitUntil(`[...document.querySelectorAll('${MENU('isolated-new')}')].some((el) => el.checkVisibility())`))
  await t.click(VISIBLE_MENU('isolated-new'), 20)
  t.ok('新建弹窗打开', await t.waitFor(CREATE))
  t.check('默认基准是远端默认分支', await t.js(checked('isolated-base-fresh')), true)
  t.check('「基于当前 HEAD」默认收在次要入口里', await t.countVisible(LABEL('isolated-base-head')), 0)
  t.ok('fetch 默认值跟设置页（设置为开）', await t.waitUntil(checked('isolated-fetch')))
  const fresh = await t.rect(LABEL('isolated-base-fresh'))
  t.ok('单选圆圈和文字在同一行', fresh.h < 30)
  await settle(t)
  await t.shot('create-default')

  await t.click('[data-testid="isolated-create-ok"]', 20)
  t.ok('fresh 失败：弹窗里显示主进程的报错原文', await t.waitForText('[data-testid="isolated-create-error"]', '没有 remote'))
  t.check('fresh 失败时没有自动改选 head', await t.js(checked('isolated-base-fresh')), true)
  t.ok('第一次创建带 fresh + fetch', (await t.events()).includes('create:{"base":"fresh","fetch":true,"carry":false}'))

  await t.click('[data-testid="isolated-more"]', 10)
  t.check('点「其他基准…」后出现 head', await t.countVisible(LABEL('isolated-base-head')), 1)
  await t.click(LABEL('isolated-base-head'), 10)
  t.ok('选 head 显示冲突风险', await t.waitFor('[data-testid="isolated-head-warning"]'))
  t.ok('风险文案写明冲突', (await t.text('[data-testid="isolated-head-warning"]')).includes('冲突'))
  t.check('head 下 fetch 不可选', await t.js(disabled('isolated-fetch')), true)
  t.check('换了基准，上一次的报错收起', await t.countVisible('[data-testid="isolated-create-error"]'), 0)
  await t.click(LABEL('isolated-carry'), 10)
  t.check('勾上「复制未提交改动」', await t.js(checked('isolated-carry')), true)
  await settle(t)
  await t.shot('create-head')
  await t.click('[data-testid="isolated-create-ok"]', 20)
  t.ok('head 创建成功后按项目打开新目录', await t.waitUntil(`(window.__uiEvents ?? []).includes('open:D:/repo/.gren/worktrees/ddd44444')`))
  t.ok('第二次创建带 head + 携带改动、没有 fetch', (await t.events()).includes('create:{"base":"head","fetch":false,"carry":true}'))
  t.ok('创建成功后弹窗关闭', await t.waitUntil(`!document.querySelector('${CREATE}')?.checkVisibility()`))

  // —— 管理弹窗 ——
  await t.act('openManage', 'aaa11111')
  t.ok('管理弹窗打开', await t.waitFor(MANAGE))
  t.ok('列出两个独立工作区', await t.waitUntil(`document.querySelectorAll('[data-testid="isolated-entry"]').length === 2`))
  t.ok('没回传的写「未回传」和领先数', await t.waitForText(`${ENTRY('aaa11111')} [data-testid="isolated-entry-tags"]`, '未回传'))
  t.ok('领先数写出来', (await t.text(ENTRY('aaa11111'))).includes('领先基准 1 个提交'))
  t.ok('已回传的写「已回传」', await t.waitForText(`${ENTRY('ccc33333')} [data-testid="isolated-entry-tags"]`, '已回传'))
  t.ok('head 基准的条目写明是当前 HEAD', (await t.text(ENTRY('ccc33333'))).includes('当前 HEAD'))
  t.ok('从侧栏点进来的条目高亮', await t.js(`document.querySelector('${ENTRY('aaa11111')}').className !== document.querySelector('${ENTRY('ccc33333')}').className`))
  await settle(t)
  await t.shot('manage')

  await t.click(`${ENTRY('aaa11111')} [data-testid="isolated-delete"]`, 10)
  t.ok('没回传的删除要「仍然删除」二次确认', await t.waitFor('[data-testid="isolated-delete-force"]'))
  t.ok('确认框说会丢掉工作', await t.waitUntil(`document.body.textContent.includes('删除后这些工作就没了')`))
  await t.click('[data-testid="isolated-delete-force"]', 10)
  t.ok('确认后带 force 删除', await t.waitUntil(`(window.__uiEvents ?? []).includes('remove:aaa11111:force')`))
  t.ok('删除后通知调用方（回父项目用）', (await t.events()).includes(`deleted:${W_LIVE}:${REPO}`))
  t.ok('列表刷新只剩一个', await t.waitUntil(`document.querySelectorAll('[data-testid="isolated-entry"]').length === 1`))

  await t.click(`${ENTRY('ccc33333')} [data-testid="isolated-delete"]`, 10)
  t.ok('已回传的删除是普通确认', await t.waitFor('[data-testid="isolated-delete-confirm"]'))
  await t.click('[data-testid="isolated-delete-confirm"]', 10)
  t.ok('普通确认不带 force', await t.waitUntil(`(window.__uiEvents ?? []).includes('remove:ccc33333:plain')`))
  t.ok('删完显示空状态', await t.waitForText(MANAGE, '还没有独立工作区'))
  await t.key('Escape')
  t.ok('管理弹窗关上', await t.waitUntil(`!document.querySelector('${MANAGE}')?.checkVisibility()`))

  // —— 已删除工作区的会话只读查看 ——
  await t.act('openViewer')
  t.ok('只读查看打开并写明只能查看', await t.waitUntil(`document.body.textContent.includes('只能查看，不能继续对话')`))
  t.ok('会话内容从 jsonl 读出来', await t.waitForText('[data-testid="isolated-readonly-session"]', '试验跑完了'))
  t.check('只读查看里没有输入框', await t.countVisible('[data-testid="isolated-readonly-session"] textarea, [data-testid="isolated-readonly-session"] [contenteditable="true"]'), 0)
  await settle(t)
  await t.shot('viewer')

  // —— 浅色主题下标签照样可读 ——
  await t.key('Escape')
  await t.setTheme('light')
  t.ok('浅色主题下行和标签还在', ((await t.text(ROW(W_GONE))) ?? '').includes('已删除'))
  await t.shot('rows-light')
}
