import { clipboard } from 'electron'

/**
 * 输入框正文原样发出：真实键入 markdown 特殊字符、Shift+Enter 换行、缩进、列表符，回车发出的文本和键入的一字不差；
 * 真实粘贴带缩进和制表符的多行代码原样发出；文件标签写成 @路径、后面的 *args 不加反斜杠；
 * 回填（草稿恢复 / 编辑消息）按纯文本写回：`- 列表` 不变成列表、行数不变、读出来和写进去相同，CRLF 统一成 LF。
 * 整份草稿：胶囊（参数填了一半）+ 文件标签 + 文字，存成 JSON 草稿、清空、再恢复，胶囊和标签仍是装饰器节点、参数值不变、读出的文本相同；
 * 只有文本的旧草稿恢复成纯文字（没有胶囊）。
 */

const COMPOSER = '[data-testid="composer"] [contenteditable]'
const PILL = '[data-testid="composer"] [data-testid="command-pill"]'
const ARG = (name) => `${PILL} input[data-arg-name="${name}"]`
const FILE_TAG = '[data-testid="composer"] [data-lexical-decorator]:not(:has([data-testid="command-pill"])):not([data-testid="command-pill"])'

async function lastSend(t) {
  const event = (await t.events()).filter((e) => e.startsWith('send:')).at(-1) ?? ''
  return event.slice('send:'.length)
}

async function fresh(t) {
  await t.act('clear')
  await t.click(COMPOSER, 20)
}

/**
 * 真实粘贴：写系统剪贴板 → webContents.paste()。用完把剪贴板原来的文字 / HTML 放回去。
 * 剪贴板被别的程序占着时写入会静默失败（读回来不是刚写的），返回 false，调用方改走粘贴的后半段。
 */
async function realPaste(t, text) {
  const saved = { text: clipboard.readText(), html: clipboard.readHTML() }
  try {
    clipboard.writeText(text)
    if (clipboard.readText() !== text) return false
    t.win.webContents.paste()
    await t.sleep(350)
    return true
  } finally {
    if (saved.text || saved.html) clipboard.write(saved)
    else clipboard.clear()
  }
}

export default async function (t) {
  t.ok('输入框渲染出来', await t.waitFor(COMPOSER))
  await t.click(COMPOSER, 20)

  // —— 键入：markdown 特殊字符、Shift+Enter、缩进、列表符 ——
  const typed = [
    'a * b [x] arr[0] ~t~ foo_bar 2*3=6 &amp; x<y',
    'def f():',
    '    return 1',
    '* one',
    '+ two',
    '# not heading',
  ]
  for (const [i, line] of typed.entries()) {
    if (i > 0) await t.key('Enter', ['shift'])
    await t.type(line)
  }
  t.info('旧路径 getDocument(markdown) 的输出', JSON.stringify(await t.act('readMarkdown')))
  await t.shot('typed')
  await t.key('Enter')
  t.check('键入：回车发出的文本和键入的一字不差', await lastSend(t), typed.join('\n'))

  // —— 真实粘贴：缩进、制表符、方括号、星号 ——
  await fresh(t)
  const code = 'if x:\n    y = a*b\n\tz = [1]_2'
  const pasted = await realPaste(t, code)
  if (!pasted) {
    t.info('系统剪贴板不可用', '跳过真实粘贴，改走 lobehub handlePlainTextPaste 拿到文本后的同一条命令')
    await t.act('insertAsPaste', code)
    await t.sleep(200)
  }
  t.info('粘贴后旧路径 getDocument(markdown)', JSON.stringify(await t.act('readMarkdown')))
  await t.key('Enter')
  t.check(
    pasted ? '真实粘贴：多行代码的缩进和符号原样发出' : '粘贴插入：多行代码的缩进和符号原样发出',
    await lastSend(t),
    code,
  )

  // —— 文件标签 + 普通文本 ——
  await fresh(t)
  await t.act('insertFileTag')
  t.ok('文件标签插入', await t.waitFor('[data-testid="composer"] [data-lexical-decorator]'))
  await t.type('look *args')
  await t.key('Enter')
  t.check('标签写成 @路径，后面的文本不加反斜杠', await lastSend(t), '@src/a_b.ts look *args')

  // —— 回填：纯文本写回，读出相同 ——
  const draft = 'a * b\n\n    缩进\n- 列表\n[link](x) \\_ok'
  await t.act('restore', draft)
  await t.sleep(200)
  t.check('回填后没有变成列表', await t.count('[data-testid="composer"] li'), 0)
  t.check('回填后每行一个段落', await t.count(`${COMPOSER} > p`), draft.split('\n').length)
  t.check('回填后读出和写进去相同', await t.act('read'), draft)
  await t.shot('restored')
  await t.click(COMPOSER, 20)
  await t.key('End', ['control'])
  await t.type('!')
  await t.key('Enter')
  t.check('回填后接着打字再发出，原文不变', await lastSend(t), `${draft}!`)

  await t.act('restore', 'a\r\nb')
  t.check('回填 CRLF 统一成 LF', await t.act('read'), 'a\nb')

  // —— 整份草稿：胶囊 + 标签 + 文字，存 → 清空 → 恢复 ——
  await fresh(t)
  await t.act('insertPill')
  t.ok('胶囊插入', await t.waitFor(PILL))
  await t.type('src/a.ts')
  await t.key('Tab')
  await t.key('Tab')
  // 胶囊插入时自带一个尾随空格，跳出后光标在它前面；删掉它，不然后面的文字会夹在两个空格之间
  await t.key('Delete')
  await t.type('看看 ')
  await t.act('insertFileTag')
  t.ok('文件标签插在胶囊后面', await t.waitFor(FILE_TAG))
  // 标签插入时自带一个空格，这里不再补
  await t.type('里的 *args')
  const expected = '/refactor "src/a.ts" "" 看看 @src/a_b.ts 里的 *args'
  t.check('存草稿前读出的文本', await t.act('read'), expected)
  const saved = await t.act('saveDraft')
  t.check('存下的草稿文本相同', saved.text, expected)
  t.ok('存下的草稿带 JSON', saved.hasJson)
  await t.shot('draft-before')

  await t.act('clear')
  await t.sleep(100)
  t.check('清空后没有胶囊', await t.count(PILL), 0)
  await t.act('restoreDraft')
  t.ok('恢复后胶囊回来', await t.waitFor(PILL))
  t.ok('恢复后文件标签回来', await t.waitFor(FILE_TAG))
  t.check('恢复后胶囊只有一个', await t.count(PILL), 1)
  t.check('恢复后 file 参数值不变', await t.js(`document.querySelector(${JSON.stringify(ARG('file'))}).value`), 'src/a.ts')
  t.check('恢复后 style 仍是空', await t.js(`document.querySelector(${JSON.stringify(ARG('style'))}).value`), '')
  t.check('恢复后读出的文本相同', await t.act('read'), expected)
  await t.shot('draft-restored')
  // 不点输入框：左沿是胶囊，点上去会进第一个空参数。restoreDraft 已经把焦点给了编辑器
  await t.key('End', ['control'])
  await t.type('!')
  await t.key('Enter')
  t.check('恢复后接着打字再发出，调用文本和标签都在', await lastSend(t), `${expected}!`)

  // —— 只有文本的旧草稿：恢复成纯文字 ——
  await t.act('clear')
  await t.act('restoreTextOnly')
  await t.sleep(200)
  t.check('旧草稿恢复后没有胶囊', await t.count(PILL), 0)
  t.check('旧草稿恢复后文本相同', await t.act('read'), expected)
}
