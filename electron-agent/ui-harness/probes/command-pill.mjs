import { clipboard } from 'electron'

/**
 * 命令胶囊：插入后焦点在第一个参数；Tab / Shift+Tab 轮转，最后一个参数上 Tab 跳出到胶囊后，第一个参数上 Shift+Tab / ← 不动；空参数 Backspace 回退、第一个参数里删整个胶囊；
 * 必填参数空着时 Enter 不发送、焦点回到缺的参数、描边变红（连续被拦时重播）；填好后发送的是调用文本（空参数发 ""）；
 * Esc 跳出、点命令名进第一个空参数、中文输入、真实粘贴多行变一行；
 * 气泡：command 块整块成胶囊、正文不出现；刚发出的调用文本也成胶囊、空参数显示默认值；浅色主题下命令名是紫色、参数焦点描边是主色。
 */

const COMPOSER = '[data-testid="composer"] [contenteditable]'
const PILL = '[data-testid="composer"] [data-testid="command-pill"]'
const PILL_NAME = `${PILL} > span:first-child`
const ARG = (name) => `${PILL} input[data-arg-name="${name}"]`
const ARG_LABEL = (name) => `${PILL} label[data-arg-label]:has(input[data-arg-name="${name}"])`
const ACTIVE = 'document.activeElement?.dataset?.argName ?? document.activeElement?.getAttribute("contenteditable")'
const ROOT_FOCUSED = `document.activeElement === document.querySelector(${JSON.stringify(COMPOSER)})`
const INVALID = `document.querySelector(${JSON.stringify(ARG('file'))}).closest('[data-invalid]').dataset.invalid`
const argValue = (name) => `document.querySelector(${JSON.stringify(ARG(name))}).value`

/** 清空输入框、点进去、插入一个新的 refactor 胶囊（焦点落在 file） */
async function freshPill(t) {
  await t.act('clear')
  await t.click(COMPOSER, 20)
  await t.act('insertRefactor')
  return t.waitFor(PILL)
}

/** 真实粘贴：写系统剪贴板 → webContents.paste()。用完把剪贴板原来的文字 / HTML 放回去 */
async function realPaste(t, text) {
  const saved = { text: clipboard.readText(), html: clipboard.readHTML() }
  try {
    clipboard.writeText(text)
    t.win.webContents.paste()
    await t.sleep(350)
  } finally {
    if (saved.text || saved.html) clipboard.write(saved)
    else clipboard.clear()
  }
}

export default async function (t) {
  t.ok('输入框渲染出来', await t.waitFor(COMPOSER))
  await t.click(COMPOSER, 20)

  // —— 插入：焦点落在第一个参数 ——
  await t.act('insertRefactor')
  t.ok('胶囊插入', await t.waitFor(PILL))
  t.check('插入后焦点在 file', await t.js(ACTIVE), 'file')
  t.check('style 空着时占位显示默认值', await t.js(`document.querySelector(${JSON.stringify(ARG('style'))}).placeholder`), 'functional')
  await t.shot('inserted')

  // —— 必填空着：拦下发送 ——
  await t.key('Enter')
  t.check('file 空着时 Enter 被拦下', (await t.events()).at(-1), 'blocked')
  t.check('拦下后焦点仍在 file', await t.js(ACTIVE), 'file')
  t.check('缺的参数标红', await t.js(INVALID), 'true')

  // 连续第二次 Enter：先清掉再下一帧设上，动画能重播。逐帧采样应看到 false → true 的跳变，最后停在 true
  const frames = await t.sample(INVALID, 600, () => t.key('Enter'))
  const events = await t.events()
  t.check('第二次 Enter 也被拦下', events.slice(-2), ['blocked', 'blocked'])
  const replayed = frames.some((value, i) => i > 0 && value === 'true' && frames[i - 1] === 'false')
  t.ok('第二次被拦时描边重新设上（false → true 跳变）', replayed)
  t.check('第二次被拦后仍标红', frames.at(-1), 'true')
  t.check('第二次被拦后焦点仍在 file', await t.js(ACTIVE), 'file')

  // —— 填值、Tab 轮转 ——
  await t.type('src/a.ts')
  await t.key('Tab')
  t.check('Tab 到 style', await t.js(ACTIVE), 'style')
  await t.key('Tab', ['shift'])
  t.check('Shift+Tab 回到 file', await t.js(ACTIVE), 'file')
  await t.key('Tab', ['shift'])
  t.check('第一个参数上 Shift+Tab 不动（胶囊前不允许有内容）', await t.js(ACTIVE), 'file')
  await t.key('Home')
  await t.key('Left')
  t.check('第一个参数开头按 ← 不动', await t.js(ACTIVE), 'file')
  t.check('值写回节点', await t.js(argValue('file')), 'src/a.ts')
  await t.key('Tab')
  await t.key('Tab')
  t.check('最后一个参数上 Tab 跳出胶囊', await t.js(ACTIVE), 'true')
  t.ok('跳出后焦点在输入框根节点', await t.js(ROOT_FOCUSED))
  await t.type('more')

  // —— 发送 ——
  await t.key('Enter')
  t.check('发送的是调用文本加补充正文', (await t.events()).at(-1), 'send:/refactor "src/a.ts" "" more')

  // —— Backspace：空参数回退，第一个参数里删胶囊 ——
  await freshPill(t)
  await t.key('Tab')
  t.check('先到 style', await t.js(ACTIVE), 'style')
  await t.key('Backspace')
  t.check('空的 style 里 Backspace 回到 file', await t.js(ACTIVE), 'file')
  await t.key('Backspace')
  t.check('空的 file 里 Backspace 删掉胶囊', await t.count(PILL), 0)

  // —— Esc：跳出到胶囊后 ——
  await freshPill(t)
  t.check('重新插入后焦点在 file', await t.js(ACTIVE), 'file')
  await t.key('Escape')
  t.ok('file 里按 Esc 后焦点在输入框根节点', await t.js(ROOT_FOCUSED))

  // —— 点命令名：进第一个空参数 ——
  await t.click(PILL_NAME)
  t.check('点命令名后焦点进第一个空参数 file', await t.js(ACTIVE), 'file')

  // —— 中文输入 ——
  await t.insertText('中文值')
  t.check('中文写进 file', await t.js(argValue('file')), '中文值')
  t.check('中文输入后焦点不跳', await t.js(ACTIVE), 'file')
  await t.key('Escape')
  await t.click(PILL_NAME)
  t.check('file 有值后点命令名进 style', await t.js(ACTIVE), 'style')
  await t.key('Escape')
  await t.key('Enter')
  t.check('中文值随调用文本发出', (await t.events()).at(-1), 'send:/refactor "中文值" ""')

  // —— 粘贴多行：换行变空格 ——
  await freshPill(t)
  t.check('粘贴前焦点在 file', await t.js(ACTIVE), 'file')
  await realPaste(t, 'line one\nline two\r\n  line three')
  t.check('多行粘贴进参数后换行变成空格', await t.js(argValue('file')), 'line one line two line three')
  t.check('粘贴后焦点仍在 file', await t.js(ACTIVE), 'file')
  t.check('粘贴没有漏进正文', await t.count(`${PILL} input`), 2)
  await t.key('Escape')
  await t.key('Enter')
  t.check('粘贴的值写回节点', (await t.events()).at(-1), 'send:/refactor "line one line two line three" ""')

  // —— 气泡 ——
  t.ok('气泡渲染出来', await t.waitFor('[data-testid="bubble-block"] [data-testid="command-pill"]'))
  const blockText = await t.text('[data-testid="bubble-block"]')
  const { blockBody } = await t.data()
  t.ok('command 块正文不出现在气泡里', !blockText.includes(blockBody))
  t.ok('command 块后的补充正文还在', blockText.includes('顺便加测试'))
  t.check('刚发出的调用文本也成胶囊', await t.count('[data-testid="bubble-optimistic"] [data-testid="command-pill"]'), 1)
  t.ok('空参数显示默认值', (await t.text('[data-testid="bubble-optimistic"]')).includes('functional'))
  t.check('没有参数模板的 /review 不成胶囊', await t.count('[data-testid="bubble-plain"] [data-testid="command-pill"]'), 0)
  await t.shot('bubbles-dark')

  // —— 浅色主题 ——
  await t.setTheme('light')
  const color = await t.style('[data-testid="bubble-block"] [data-testid="command-pill"] > span:first-child', ['color'])
  const purple = await t.js(`getComputedStyle(document.documentElement).getPropertyValue('--ant-purple').trim() || getComputedStyle(document.documentElement).getPropertyValue('--ant-color-purple').trim()`)
  t.info('浅色主题命令名颜色', color.color)
  t.ok('浅色主题能读到紫色变量', Boolean(purple))
  await t.shot('bubbles-light')

  // 参数焦点描边：box-shadow 的颜色是主色（在输入框里解析 var(--ant-color-primary)，变量作用域和胶囊一致）
  await freshPill(t)
  t.check('浅色主题下焦点在 file', await t.js(ACTIVE), 'file')
  const ring = await t.style(ARG_LABEL('file'), ['box-shadow'])
  t.info('浅色主题参数焦点描边', ring?.boxShadow)
  const primary = await t.js(`(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--ant-color-primary)'
    document.querySelector('[data-testid="composer"]').appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })()`)
  t.info('浅色主题 --ant-color-primary', primary)
  const ringColor = /rgba?\([^)]*\)/.exec(ring?.boxShadow ?? '')?.[0] ?? null
  t.checkColor('浅色主题参数焦点描边是主色', ringColor, primary)
  await t.shot('focus-light')
}
