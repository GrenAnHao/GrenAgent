/**
 * 会话标题：没有生成标题的会话按首条消息兜底，侧栏不出现 <pi:attachment / <skill / [Image；
 * 右键菜单「重命名」下面有「重新生成标题」，点了先出「正在生成标题…」，拿到标题后行标题换掉并提示；
 * 生成不出时提示保留原标题、行标题不变；主进程报错时提示原因；浅色主题下提示可见。
 */

const ROWS = '[data-testid="sidebar"] .pi-session-row'
const MENU_OPEN = `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`
const TOAST = '.ant-message-notice'

const rowPoint = (t, title) =>
  t.js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(ROWS)})].find((r) => r.textContent.includes(${JSON.stringify(title)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + 40, y: r.y + r.height / 2 }
  })()`)

const rowTitles = (t) => t.js(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].map((r) => r.textContent.trim())`)

const visibleMenuLabels = (t) =>
  t.js(`[...document.querySelectorAll('[role="menuitem"]')].filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true })).map((el) => el.textContent.trim())`)

async function clickMenuItem(t, label) {
  const p = await t.js(`(() => {
    const el = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${JSON.stringify(label)} && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + 20, y: r.y + r.height / 2 }
  })()`)
  if (!p) return null
  return t.click(p)
}

const toastText = (t) => t.js(`[...document.querySelectorAll(${JSON.stringify(TOAST)})].map((el) => el.textContent.trim()).join(' | ')`)

async function regenerate(t, title) {
  await t.rightClick(await rowPoint(t, title))
  await t.waitUntil(MENU_OPEN)
  await clickMenuItem(t, '重新生成标题')
}

export default async function (t) {
  const { names, paths } = await t.data()
  t.ok('侧栏渲染出来', await t.waitFor(ROWS))
  await t.mouse(2, 2)

  // —— 兜底标题 ——
  const titles = await rowTitles(t)
  t.info('侧栏行', JSON.stringify(titles))
  t.ok('兜底：没有一行显示 <pi:attachment / <skill / [Image', !titles.some((s) => /<pi:attachment|<skill|\[Image/.test(s)))
  t.ok(`兜底：粘贴块会话显示粘贴内容第一行「${names.PASTED}」`, titles.some((s) => s.includes('我们要为客服模块')))
  t.ok(`兜底：技能会话显示用户正文「${names.SKILL}」`, titles.some((s) => s.includes('规划套餐订购页')))
  t.ok(`兜底：带图会话不带图片说明「${names.IMAGE}」`, titles.some((s) => s === names.IMAGE))
  await t.shot('fallback')

  // —— 菜单项位置 ——
  await t.rightClick(await rowPoint(t, '# 生成标题'))
  t.ok('右键：菜单弹出', await t.waitUntil(MENU_OPEN))
  const labels = await visibleMenuLabels(t)
  t.check('右键：「重新生成标题」紧跟在「重命名」后面', labels[labels.indexOf('重命名') + 1], '重新生成标题')
  await t.shot('menu')

  // —— 成功：先提示生成中，拿到标题后改名 ——
  await clickMenuItem(t, '重新生成标题')
  t.ok('生成中：主进程收到这一份会话路径', (await t.events()).includes(`generate:${paths.LEGACY}`))
  t.ok('生成中：提示「正在生成标题…」', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(TOAST)})].some((el) => el.textContent.includes('正在生成标题'))`))
  t.ok('生成中：行标题还没变', (await rowTitles(t)).includes('# 生成标题'))
  await t.act('resolveTitle', '套餐订购页规划')
  t.ok('成功：行标题换成新标题', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.trim() === '套餐订购页规划')`))
  t.ok('成功：旧标题不在了', !(await rowTitles(t)).includes('# 生成标题'))
  t.ok('成功：提示「标题已更新：套餐订购页规划」', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(TOAST)})].some((el) => el.textContent.includes('标题已更新：套餐订购页规划'))`))
  t.ok('成功：生成中的提示被替换掉', !(await toastText(t)).includes('正在生成标题'))
  await t.shot('regenerated')

  // —— 生成不出：保留原标题 ——
  await regenerate(t, names.SKILL)
  await t.act('resolveTitle', '')
  t.ok('空结果：提示保留原标题', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(TOAST)})].some((el) => el.textContent.includes('没有生成出合适的标题'))`))
  t.ok('空结果：行标题不变', (await rowTitles(t)).some((s) => s.includes('规划套餐订购页')))
  t.check('空结果：没有改名', (await t.events()).filter((e) => e.startsWith(`rename:${paths.SKILL}`)).length, 0)

  // —— 主进程报错：提示原因 ——
  await regenerate(t, names.SKILL)
  await t.act('rejectTitle', '模型不可用')
  t.ok('报错：提示「生成标题失败：模型不可用」', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(TOAST)})].some((el) => el.textContent.includes('生成标题失败') && el.textContent.includes('模型不可用'))`))
  t.ok('报错：行标题不变', (await rowTitles(t)).some((s) => s.includes('规划套餐订购页')))

  // —— 浅色主题 ——
  await t.setTheme('light')
  await regenerate(t, '套餐订购页规划')
  t.ok('浅色：生成中提示可见', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(TOAST)})].some((el) => el.textContent.includes('正在生成标题') && el.checkVisibility())`))
  // 底色画在提示里哪一层随 antd 版本变：取提示及其子元素里第一个不透明的底色
  const bg = await t.js(`(() => {
    const notice = [...document.querySelectorAll(${JSON.stringify(TOAST)})].at(-1)
    if (!notice) return null
    for (const el of [notice, ...notice.querySelectorAll('*')]) {
      const color = getComputedStyle(el).backgroundColor
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
    }
    return null
  })()`)
  t.info('浅色：提示底色', bg)
  t.ok('浅色：提示是浅底', /^rgba?\((2[0-9]{2}|1[89][0-9]), *(2[0-9]{2}|1[89][0-9]), *(2[0-9]{2}|1[89][0-9])/.test(bg ?? ''))
  await t.act('resolveTitle', '套餐订购页模态框规划')
  t.ok('浅色：再次生成后标题更新', await t.waitUntil(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].some((r) => r.textContent.trim() === '套餐订购页模态框规划')`))
  await t.shot('light')
}
