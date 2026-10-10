/**
 * 文件浏览器（「文件」标签）：
 * - 只列根，展开才列那一层；2000 个文件的目录只渲染可视区，滚到底能看到最后一个。
 * - .md 默认预览；Ctrl+E 进编辑，宽屏左右分栏；改完 Ctrl+S 写盘；Esc 回预览。
 * - .ts 默认只读打不进字；切「编辑」后能改能存。CRLF 文件保存后其余行仍是 CRLF。
 * - 有未保存修改时切文件弹「保存 / 放弃 / 取消」。
 * - 二进制显示不支持预览、可用系统打开；超大文件标「已截断」且不能编辑；svg 图片显示。
 * - 外部改动：没本地修改静默换新；有本地修改出冲突提示，可保留；新文件出现在树里。
 * - 切主题：编辑器 DOM 不换、颜色跟着变；预览颜色也变。分隔条可拖。筛选只留命中项和祖先。
 */

const TREE = '[data-testid="file-tree"]'
const EDITOR = '[data-testid="file-code-editor"]'
const CONTENT = `${EDITOR} .cm-content`
const PREVIEW = '[data-testid="file-markdown-preview"]'
const MODAL = '.ant-modal-confirm'

const docText = `[...document.querySelectorAll('${CONTENT} .cm-line')].map((l) => l.textContent).join('\\n')`
const treeTitles = `[...document.querySelectorAll('${TREE} .ant-tree-title')].map((el) => el.textContent)`
const isVisible = (sel) => `(() => { const el = document.querySelector('${sel}'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`

/** 给树里名字为 name 的节点打标记，返回能点的选择器。 */
async function treeNode(t, name) {
  const found = await t.js(`(() => {
    document.querySelectorAll('[data-probe-node]').forEach((n) => n.removeAttribute('data-probe-node'))
    const el = [...document.querySelectorAll('${TREE} .ant-tree-title')].find((n) => n.textContent === ${JSON.stringify(name)})
    if (!el) return false
    el.setAttribute('data-probe-node', '1')
    return true
  })()`)
  return found ? '[data-probe-node="1"]' : null
}

async function openNode(t, name) {
  const sel = await treeNode(t, name)
  if (!sel) {
    t.ok(`树里有 ${name}`, false)
    return
  }
  await t.click(sel, 4)
}

/** 给可见、文字（去掉空格）等于 text 的按钮打标记。 */
async function button(t, text, scope = 'body') {
  const found = await t.js(`(() => {
    document.querySelectorAll('[data-probe-btn]').forEach((n) => n.removeAttribute('data-probe-btn'))
    const el = [...document.querySelectorAll('${scope} button')].find((b) => b.textContent.replace(/[ ]/g, '') === ${JSON.stringify(text)} && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.setAttribute('data-probe-btn', '1')
    return true
  })()`)
  return found ? '[data-probe-btn="1"]' : null
}

/** 点「预览 / 只读 / 编辑」切换里文字为 text 的那一项（Segmented 的项是 label，不是 button）。 */
async function segment(t, text) {
  const found = await t.js(`(() => {
    document.querySelectorAll('[data-probe-seg]').forEach((n) => n.removeAttribute('data-probe-seg'))
    const el = [...document.querySelectorAll('[data-testid="file-mode-switch"] .ant-segmented-item')].find((n) => n.textContent.replace(/[ ]/g, '') === ${JSON.stringify(text)})
    if (!el) return false
    el.setAttribute('data-probe-seg', '1')
    return true
  })()`)
  if (!found) {
    t.ok(`有「${text}」切换`, false)
    return
  }
  await t.click('[data-probe-seg="1"]', 10)
}

/** 光标放到文档末尾再敲字。 */
async function typeAtEnd(t, chars) {
  await t.click(CONTENT, 40)
  await t.key('End', ['control'])
  await t.type(chars)
}

const lastWrite = async (t) => ((await t.data()).writes ?? []).at(-1) ?? { path: '', content: '' }

export default async function (t) {
  const { bigCount } = await t.data()

  // —— 树：只列根，展开才列 ——
  t.ok('根目录列出', await t.waitUntil(`${treeTitles}.includes('README.md')`))
  t.check('根目录：目录在前，node_modules 不列', await t.js(treeTitles), ['big', 'docs', 'src', 'app.bin', 'crlf.txt', 'huge.log', 'logo.svg', 'README.md'])
  t.check('一开始只列了根', (await t.events()).filter((e) => e.startsWith('list:')), ['list:/repo'])
  await openNode(t, 'src')
  t.ok('展开 src', await t.waitUntil(`${treeTitles}.includes('app.ts')`))
  t.ok('展开时才列 src', (await t.events()).includes('list:/repo/src'))
  t.ok('展开的目录交给主进程监听', await t.waitUntil(`(window.__uiData?.watched ?? []).includes('/repo/src')`))

  // —— 大目录：虚拟滚动 ——
  await openNode(t, 'big')
  t.ok('展开 big', await t.waitUntil(`${treeTitles}.includes('file-0001.ts')`))
  const rendered = await t.count(`${TREE} .ant-tree-treenode`)
  t.info('big 展开后渲染的节点数', rendered)
  t.ok(`${bigCount} 个文件只渲染可视区`, rendered < 200)
  const fps = await t.scrollFps(`${TREE} .ant-tree-list-holder`, 1200)
  t.info('树滚动 fps（静默模式仅参考）', fps)
  for (let i = 0; i < 30 && !(await t.js(`${treeTitles}.includes('file-2000.ts')`)); i++) {
    await t.wheel(`${TREE} .ant-tree-list-holder`, 4000)
  }
  t.ok('滚到底能看到最后一个文件', await t.js(`${treeTitles}.includes('file-2000.ts')`))
  await t.js(`document.querySelector('${TREE} .ant-tree-list-holder').scrollTop = 0`)
  t.ok('滚回顶部', await t.waitUntil(`${treeTitles}.includes('big')`))
  await openNode(t, 'big')
  t.ok('收起 big', await t.waitUntil(`!${treeTitles}.includes('file-0001.ts')`))

  // —— Markdown：默认预览 → 编辑 → 保存 → Esc ——
  await openNode(t, 'README.md')
  t.ok('README 默认预览', await t.waitForText(`${PREVIEW} h1`, 'Hello Pi'))
  t.ok('表格渲染出来', (await t.count(`${PREVIEW} table`)) === 1)
  t.check('只看不改时不挂编辑器', await t.count(EDITOR), 0)
  t.check('面包屑是相对路径', await t.text('[data-testid="file-viewer-path"]'), 'README.md')

  await t.click(PREVIEW, 40)
  await t.key('e', ['control'])
  t.ok('Ctrl+E 进编辑', await t.waitFor(`${CONTENT} .cm-line`))
  t.ok('宽屏：编辑和预览左右并排', (await t.js(isVisible(EDITOR))) && (await t.js(isVisible(PREVIEW))))
  await typeAtEnd(t, 'Edited line')
  t.ok('改了出现未保存圆点', await t.waitFor('[data-testid="file-dirty-dot"]'))
  t.ok('分栏预览防抖后跟上', await t.waitForText(PREVIEW, 'Edited line'))
  await t.key('s', ['control'])
  t.ok('Ctrl+S 写盘', await t.waitUntil(`(window.__uiData?.writes ?? []).some((w) => w.path === '/repo/README.md' && w.content.includes('Edited line'))`))
  t.ok('保存后圆点消失', await t.waitUntil(`!document.querySelector('[data-testid="file-dirty-dot"]')`))
  await t.shot('markdown-split')

  const narrow = await t.resize(1000, 880)
  t.ok('窄屏编辑：只有编辑器', await t.waitUntil(`!document.querySelector('${PREVIEW}')`))
  await t.resize(narrow[0], narrow[1])
  await t.click(CONTENT, 40)
  await t.key('Escape')
  t.ok('Esc 回到预览', await t.waitUntil(`${isVisible(PREVIEW)} && !${isVisible(EDITOR)}`))

  // —— 代码：默认只读 → 编辑 → 保存 ——
  await openNode(t, 'app.ts')
  t.ok('app.ts 打开', await t.waitUntil(`${docText}.startsWith('export function add')`))
  const before = await t.js(docText)
  await typeAtEnd(t, 'zzz')
  t.check('只读：敲字不进文档', await t.js(docText), before)
  t.check('只读：保存不可点', await t.js(`document.querySelector('[data-testid="file-save"]').disabled`), true)
  await segment(t, '编辑')
  await typeAtEnd(t, '// edited')
  t.ok('编辑：敲字进文档', await t.waitUntil(`${docText}.includes('// edited')`))

  // —— 未保存时切文件 ——
  await openNode(t, 'util.json')
  t.ok('弹出未保存提示', await t.waitUntil(`document.querySelectorAll('${MODAL}').length > 0 && ${isVisible(MODAL)}`))
  await t.shot('unsaved-modal')
  await t.click(await button(t, '取消', MODAL), 10)
  t.ok('取消：对话框关掉', await t.waitUntil(`!${isVisible(MODAL)}`))
  t.check('取消：还在 app.ts，修改还在', await t.text('[data-testid="file-viewer-path"]'), 'src/app.ts')
  t.ok('取消：修改还在', (await t.js(docText)).includes('// edited'))

  await t.click('[data-testid="file-save"]', 10)
  t.ok('点保存写盘', await t.waitUntil(`(window.__uiData?.writes ?? []).some((w) => w.path === '/repo/src/app.ts' && w.content.includes('// edited'))`))

  await typeAtEnd(t, ' more')
  await openNode(t, 'util.json')
  t.ok('再次弹出提示', await t.waitUntil(isVisible(MODAL)))
  await t.click('[data-testid="file-unsaved-discard"]', 10)
  t.ok('放弃：切到 util.json', await t.waitUntil(`${docText}.includes('"name": "util"')`))
  t.ok('放弃：没有多写盘', !(await lastWrite(t)).content.includes(' more'))

  // —— 切主题：编辑器不重建 ——
  await t.js(`window.__cmEditorEl = document.querySelector('${EDITOR} .cm-editor')`)
  const darkColor = (await t.style(CONTENT, ['color'])).color
  await t.setTheme('light')
  t.ok('切浅色：编辑器 DOM 还是同一个', await t.js(`window.__cmEditorEl === document.querySelector('${EDITOR} .cm-editor')`))
  const lightColor = (await t.style(CONTENT, ['color'])).color
  t.info('编辑器正文颜色', { darkColor, lightColor })
  t.ok('切浅色：编辑器文字颜色变了', darkColor !== lightColor)
  await openNode(t, 'README.md')
  t.ok('预览出现', await t.waitForText(`${PREVIEW} h1`, 'Hello Pi'))
  const previewLight = (await t.style(`${PREVIEW} h1`, ['color'])).color
  await t.setTheme('dark')
  const previewDark = (await t.style(`${PREVIEW} h1`, ['color'])).color
  t.ok('切深色：预览标题颜色变了', previewLight !== previewDark)

  // —— 二进制 / 超大 / 图片 ——
  await openNode(t, 'app.bin')
  t.ok('二进制：不支持预览', await t.waitFor('[data-testid="file-unsupported"]'))
  await t.click(await button(t, '用系统打开', '[data-testid="file-unsupported"]'), 10)
  t.ok('用系统打开（主进程校验路径）', (await t.events()).includes('open:/repo/app.bin'))

  await openNode(t, 'huge.log')
  t.ok('超大文件：已截断标记', await t.waitFor('[data-testid="file-truncated-tag"]'))
  t.ok('超大文件：切换不可用', await t.js(`document.querySelector('[data-testid="file-mode-switch"]').className.includes('disabled')`))
  await t.click(CONTENT, 40)
  await t.key('e', ['control'])
  t.check('超大文件：Ctrl+E 也进不了编辑', await t.js(`document.querySelector('[data-testid="file-save"]').disabled`), true)

  await openNode(t, 'logo.svg')
  t.ok('图片显示', await t.waitUntil(`document.querySelector('[data-testid="file-image-preview"] img')?.naturalWidth > 0`))

  // —— CRLF 与外部改动 ——
  await openNode(t, 'crlf.txt')
  t.ok('crlf.txt 打开', await t.waitUntil(`${docText}.startsWith('line one')`))
  await t.act('externalEdit', '/repo/crlf.txt', 'line one\r\nline two\r\nchanged outside\r\n')
  t.ok('没本地修改：静默换成磁盘内容', await t.waitUntil(`${docText}.includes('changed outside')`))
  t.check('没本地修改：不出冲突提示', await t.count('[data-testid="file-disk-changed"]'), 0)

  await segment(t, '编辑')
  await typeAtEnd(t, 'mine')
  await t.act('externalEdit', '/repo/crlf.txt', 'line one\r\nsomeone else\r\n')
  t.ok('有本地修改：出冲突提示', await t.waitFor('[data-testid="file-disk-changed"]'))
  t.ok('有本地修改：内容不被覆盖', (await t.js(docText)).includes('mine'))
  await t.shot('disk-changed')
  await t.click(await button(t, '保留我的修改', '[data-testid="file-disk-changed"]'), 10)
  t.ok('保留：提示消失', await t.waitUntil(`!document.querySelector('[data-testid="file-disk-changed"]')`))
  await t.key('s', ['control'])
  t.ok('保存 crlf.txt', await t.waitUntil(`(window.__uiData?.writes ?? []).some((w) => w.path === '/repo/crlf.txt')`))
  const crlf = await lastWrite(t)
  t.info('crlf.txt 写盘内容', JSON.stringify(crlf.content))
  t.ok('CRLF 保留：原有行仍以 \\r\\n 分隔', crlf.content.startsWith('line one\r\nline two\r\nchanged outside\r\n'))
  t.ok('CRLF 保留：没有落单的 \\n', !/[^\r]\n/.test(crlf.content))

  await t.act('addFile', '/repo/src/new-file.ts', 'export {}\n')
  t.ok('新文件出现在树里', await t.waitUntil(`${treeTitles}.includes('new-file.ts')`))

  // —— 筛选 ——
  await t.click('[data-testid="file-tree-search"] input, input[data-testid="file-tree-search"]', 20)
  await t.type('util')
  t.ok('筛选：只留命中项和祖先', await t.waitUntil(`${treeTitles}.join() === 'src,util.json'`))
  await t.key('a', ['control'])
  await t.key('Backspace')
  t.ok('清空筛选：恢复', await t.waitUntil(`${treeTitles}.includes('README.md')`))

  // —— 分隔条 ——
  const pane = await t.rect('[data-testid="file-explorer-splitter"]')
  const treeBefore = await t.js(`Math.round(document.querySelector('[data-testid="file-explorer-splitter"]').previousElementSibling.getBoundingClientRect().width)`)
  await t.drag({ x: pane.x + 2, y: pane.y + 300 }, { x: pane.x + 102, y: pane.y + 300 })
  const treeAfter = await t.js(`Math.round(document.querySelector('[data-testid="file-explorer-splitter"]').previousElementSibling.getBoundingClientRect().width)`)
  t.checkNear('拖分隔条：文件树变宽 100px', treeAfter, treeBefore + 100, 3)

  await t.shot('dark')
  await t.setTheme('light')
  await t.mouse(2, 2)
  const selected = await t.style(`${TREE} .ant-tree-treenode-selected .ant-tree-node-content-wrapper`, ['color'])
  t.info('选中项文字颜色', selected)
  t.ok('选中项是浅底色、文字不是反白', selected.color !== 'rgb(255, 255, 255)')
  await t.shot('light')
}
