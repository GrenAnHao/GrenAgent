/**
 * 文件管理器（「文件管理器」标签）：
 * - 打开的文件各占一个文件标签；再打开同一个只切过去。切走的标签藏起来不卸载，所以内容区里的选择器都限定在当前标签（ACTIVE）。
 * - 只列根，展开才列那一层；2000 个文件的目录只渲染可视区，滚到底能看到最后一个。
 * - .md 默认预览；Ctrl+E 进编辑，宽屏左右分栏；改完 Ctrl+S 写盘；Esc 回预览。
 * - .ts 默认只读打不进字；切「编辑」后能改能存。CRLF 文件保存后其余行仍是 CRLF。
 * - 有未保存修改时打开别的文件不问、修改留在原标签；关这个标签时弹「保存 / 放弃 / 取消」。
 * - 标签栏：同名文件带目录提示、滚轮横滚、当前标签滚进可视区、中键关闭、右键「关闭其他 / 全部关闭」。
 * - 二进制显示不支持预览、可用系统打开；超大文件标「已截断」且不能编辑；svg 图片显示。
 * - 外部改动：没本地修改静默换新；有本地修改出冲突提示，可保留；新文件出现在树里。
 * - 切主题：编辑器 DOM 不换、颜色跟着变；预览颜色也变。分隔条可拖。筛选只留命中项和祖先。
 */

const TREE = '[data-testid="file-tree"]'
const ACTIVE = '[data-testid="file-tab-pane"][data-active="true"]'
const EDITOR = `${ACTIVE} [data-testid="file-code-editor"]`
const CONTENT = `${EDITOR} .cm-content`
const PREVIEW = `${ACTIVE} [data-testid="file-markdown-preview"]`
const TAB = (path) => `[data-testid="file-tab"][data-path="${path}"]`
const tabPaths = `[...document.querySelectorAll('[data-testid="file-tab"]')].map((el) => el.dataset.path)`
const activeTab = `document.querySelector('[data-testid="file-tab"][data-active="true"]')?.dataset.path`
const MODAL = '.ant-modal-confirm'

const docText = `[...document.querySelectorAll('${CONTENT} .cm-line')].map((l) => l.textContent).join('\\n')`
const treeTitles = `[...document.querySelectorAll('${TREE} [data-tree-title]')].map((el) => el.textContent)`
const isVisible = (sel) => `(() => { const el = document.querySelector('${sel}'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`

/** 给树里名字为 name 的节点打标记，返回能点的选择器。 */
async function treeNode(t, name) {
  const found = await t.js(`(() => {
    document.querySelectorAll('[data-probe-node]').forEach((n) => n.removeAttribute('data-probe-node'))
    const el = [...document.querySelectorAll('${TREE} [data-tree-title]')].find((n) => n.textContent === ${JSON.stringify(name)})
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
    const el = [...document.querySelectorAll('${ACTIVE} [data-testid="file-mode-switch"] .ant-segmented-item')].find((n) => n.textContent.replace(/[ ]/g, '') === ${JSON.stringify(text)})
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
  const rendered = await t.count(`${TREE} [data-tree-row]`)
  t.info('big 展开后渲染的节点数', rendered)
  t.ok(`${bigCount} 个文件只渲染可视区`, rendered < 200)
  const fps = await t.scrollFps(TREE, 1200)
  t.info('树滚动 fps（静默模式仅参考）', fps)
  for (let i = 0; i < 30 && !(await t.js(`${treeTitles}.includes('file-2000.ts')`)); i++) {
    await t.wheel(TREE, 4000)
  }
  t.ok('滚到底能看到最后一个文件', await t.js(`${treeTitles}.includes('file-2000.ts')`))
  await t.js(`document.querySelector('${TREE}').scrollTop = 0`)
  t.ok('滚回顶部', await t.waitUntil(`${treeTitles}.includes('big')`))
  await openNode(t, 'big')
  t.ok('收起 big', await t.waitUntil(`!${treeTitles}.includes('file-0001.ts')`))

  // —— Markdown：默认预览 → 编辑 → 保存 → Esc ——
  await openNode(t, 'README.md')
  t.ok('README 默认预览', await t.waitForText(`${PREVIEW} h1`, 'Hello Pi'))
  t.ok('表格渲染出来', (await t.count(`${PREVIEW} table`)) === 1)
  t.check('只看不改时不挂编辑器', await t.count(EDITOR), 0)
  t.check('面包屑是相对路径', await t.text(`${ACTIVE} [data-testid="file-viewer-path"]`), 'README.md')

  await t.click(PREVIEW, 40)
  await t.key('e', ['control'])
  t.ok('Ctrl+E 进编辑', await t.waitFor(`${CONTENT} .cm-line`))
  t.ok('宽屏：编辑和预览左右并排', (await t.js(isVisible(EDITOR))) && (await t.js(isVisible(PREVIEW))))
  await typeAtEnd(t, 'Edited line')
  t.ok('改了出现未保存圆点', await t.waitFor(`${ACTIVE} [data-testid="file-dirty-dot"]`))
  t.ok('分栏预览防抖后跟上', await t.waitForText(PREVIEW, 'Edited line'))
  await t.key('s', ['control'])
  t.ok('Ctrl+S 写盘', await t.waitUntil(`(window.__uiData?.writes ?? []).some((w) => w.path === '/repo/README.md' && w.content.includes('Edited line'))`))
  t.ok('保存后圆点消失', await t.waitUntil(`!document.querySelector('${ACTIVE} [data-testid="file-dirty-dot"]')`))
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
  t.check('只读：保存不可点', await t.js(`document.querySelector('${ACTIVE} [data-testid="file-save"]').disabled`), true)
  await segment(t, '编辑')
  await typeAtEnd(t, '// edited')
  t.ok('编辑：敲字进文档', await t.waitUntil(`${docText}.includes('// edited')`))

  // —— 未保存时打开别的文件：新开标签、不问；关这个标签才问 ——
  await openNode(t, 'util.json')
  t.ok('打开 util.json：新开一个标签并切过去', await t.waitUntil(`${activeTab} === '/repo/src/util.json' && ${docText}.includes('"name": "util"')`))
  await t.sleep(300)
  t.ok('打开别的文件不弹未保存提示', !(await t.js(isVisible(MODAL))))
  t.check('三个文件各一个标签，按打开顺序', await t.js(tabPaths), ['/repo/README.md', '/repo/src/app.ts', '/repo/src/util.json'])
  t.check('app.ts 标签标未保存', await t.js(`document.querySelector('${TAB('/repo/src/app.ts')}').dataset.dirty`), 'true')
  t.ok('未保存的标签显示圆点', await t.js(isVisible(`${TAB('/repo/src/app.ts')} [data-testid="file-tab-dirty"]`)))
  await t.shot('tabs-dirty')

  const viewsOfApp = (await t.events()).filter((e) => e === 'view:/repo/src/app.ts').length
  await t.click(TAB('/repo/src/app.ts'), 20)
  t.ok('切回 app.ts：修改还在、还是编辑模式', await t.waitUntil(`${activeTab} === '/repo/src/app.ts' && ${docText}.includes('// edited')`))
  t.check('切回 app.ts：没有重新读盘', (await t.events()).filter((e) => e === 'view:/repo/src/app.ts').length, viewsOfApp)
  t.check('切回 app.ts：面包屑是 app.ts', await t.text(`${ACTIVE} [data-testid="file-viewer-path"]`), 'src/app.ts')

  await t.click(`${TAB('/repo/src/app.ts')} [data-testid="file-tab-close"]`, 9)
  t.ok('关未保存的标签：弹出未保存提示', await t.waitUntil(`document.querySelectorAll('${MODAL}').length > 0 && ${isVisible(MODAL)}`))
  await t.shot('unsaved-modal')
  await t.click(await button(t, '取消', MODAL), 10)
  t.ok('取消：对话框关掉', await t.waitUntil(`!${isVisible(MODAL)}`))
  t.check('取消：标签还在、还是当前标签', [await t.js(tabPaths), await t.js(activeTab)], [['/repo/README.md', '/repo/src/app.ts', '/repo/src/util.json'], '/repo/src/app.ts'])
  t.ok('取消：修改还在', (await t.js(docText)).includes('// edited'))

  await t.click(`${ACTIVE} [data-testid="file-save"]`, 10)
  t.ok('点保存写盘', await t.waitUntil(`(window.__uiData?.writes ?? []).some((w) => w.path === '/repo/src/app.ts' && w.content.includes('// edited'))`))
  t.ok('保存后标签不再标未保存', await t.waitUntil(`document.querySelector('${TAB('/repo/src/app.ts')}').dataset.dirty === 'false'`))

  await typeAtEnd(t, ' more')
  t.ok('又改了：标签又标未保存', await t.waitUntil(`document.querySelector('${TAB('/repo/src/app.ts')}').dataset.dirty === 'true'`))
  await t.click(`${TAB('/repo/src/app.ts')} [data-testid="file-tab-close"]`, 9)
  t.ok('再次弹出提示', await t.waitUntil(isVisible(MODAL)))
  await t.click('[data-testid="file-unsaved-discard"]', 10)
  t.ok('放弃：标签关掉，切到右边的 util.json', await t.waitUntil(`${tabPaths}.join() === '/repo/README.md,/repo/src/util.json' && ${activeTab} === '/repo/src/util.json' && ${docText}.includes('"name": "util"')`))
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
  t.ok('二进制：不支持预览', await t.waitFor(`${ACTIVE} [data-testid="file-unsupported"]`))
  await t.click(await button(t, '用系统打开', `${ACTIVE} [data-testid="file-unsupported"]`), 10)
  t.ok('用系统打开（主进程校验路径）', (await t.events()).includes('open:/repo/app.bin'))

  await openNode(t, 'huge.log')
  t.ok('超大文件：已截断标记', await t.waitFor(`${ACTIVE} [data-testid="file-truncated-tag"]`))
  t.ok('超大文件：切换不可用', await t.js(`document.querySelector('${ACTIVE} [data-testid="file-mode-switch"]').className.includes('disabled')`))
  await t.click(CONTENT, 40)
  await t.key('e', ['control'])
  t.check('超大文件：Ctrl+E 也进不了编辑', await t.js(`document.querySelector('${ACTIVE} [data-testid="file-save"]').disabled`), true)

  await openNode(t, 'logo.svg')
  t.ok('图片显示', await t.waitUntil(`document.querySelector('${ACTIVE} [data-testid="file-image-preview"] img')?.naturalWidth > 0`))

  // —— CRLF 与外部改动 ——
  await openNode(t, 'crlf.txt')
  t.ok('crlf.txt 打开', await t.waitUntil(`${docText}.startsWith('line one')`))
  await t.act('externalEdit', '/repo/crlf.txt', 'line one\r\nline two\r\nchanged outside\r\n')
  t.ok('没本地修改：静默换成磁盘内容', await t.waitUntil(`${docText}.includes('changed outside')`))
  t.check('没本地修改：不出冲突提示', await t.count(`${ACTIVE} [data-testid="file-disk-changed"]`), 0)

  await segment(t, '编辑')
  await typeAtEnd(t, 'mine')
  await t.act('externalEdit', '/repo/crlf.txt', 'line one\r\nsomeone else\r\n')
  t.ok('有本地修改：出冲突提示', await t.waitFor(`${ACTIVE} [data-testid="file-disk-changed"]`))
  t.ok('有本地修改：内容不被覆盖', (await t.js(docText)).includes('mine'))
  await t.shot('disk-changed')
  await t.click(await button(t, '保留我的修改', `${ACTIVE} [data-testid="file-disk-changed"]`), 10)
  t.ok('保留：提示消失', await t.waitUntil(`!document.querySelector('${ACTIVE} [data-testid="file-disk-changed"]')`))
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

  // —— 分隔条（文件树在右边，往左拖变宽）——
  const treeWidthOf = () =>
    t.js(`Math.round(document.querySelector('[data-testid="file-explorer-tree"]').getBoundingClientRect().width)`)
  const pane = await t.rect('[data-testid="file-explorer-splitter"]')
  const treeBefore = await treeWidthOf()
  await t.drag({ x: pane.x + 2, y: pane.y + 300 }, { x: pane.x - 98, y: pane.y + 300 })
  const treeAfter = await treeWidthOf()
  t.checkNear('拖分隔条：文件树变宽 100px', treeAfter, treeBefore + 100, 3)

  // —— 收起 / 展开 ——
  await t.click('[data-testid="file-explorer-tree-toggle"]', 8)
  t.ok('收起：文件树不占位', await t.waitUntil(`!document.querySelector('[data-testid="file-explorer-tree"]')`))
  t.ok('收起：内容还在', await t.js(isVisible(`${ACTIVE} [data-testid="file-viewer"]`)))
  t.check('收起：按钮改成展开', await t.js(`document.querySelector('[data-testid="file-explorer-tree-toggle"]').getAttribute('aria-expanded')`), 'false')
  await t.click('[data-testid="file-explorer-tree-toggle"]', 8)
  t.ok('展开：文件树回来', await t.waitFor('[data-testid="file-explorer-tree"]'))
  t.ok('展开：文件还在', await t.waitUntil(`${treeTitles}.includes('README.md')`))

  // —— 外部请求打开（交付卡 / 审查标签走 openWorkspaceFile，最后发到这里）——
  const explorerWidth = () => t.js(`Math.round(document.querySelector('[data-testid="file-explorer"]').getBoundingClientRect().width)`)
  const treeWBefore = await treeWidthOf()
  const panelWBefore = await explorerWidth()
  t.ok('请求前 docs 没展开', !(await t.js(treeTitles)).includes('guide.md'))
  await t.act('requestOpen', '/repo/docs/guide.md')
  t.ok('外部请求：预览里是 guide.md 的内容', await t.waitUntil(`document.querySelector('${PREVIEW}')?.textContent.includes('Read me.')`))
  t.ok('外部请求：docs 自动展开、选中 guide.md', await t.waitUntil(`document.querySelector('${TREE} [data-tree-row][data-selected="true"]')?.textContent.includes('guide.md')`))
  t.check('外部请求：文件树宽度不变', await treeWidthOf(), treeWBefore)
  t.check('外部请求：文件标签宽度不变', await explorerWidth(), panelWBefore)
  t.ok('外部请求：文件树没收起', await t.js(isVisible('[data-testid="file-explorer-tree"]')))
  const viewsBefore = (await t.events()).filter((e) => e === 'view:/repo/docs/guide.md').length
  await t.act('requestOpen', '/repo/docs/guide.md')
  await t.act('requestOpen', '/repo/docs/guide.md')
  await t.sleep(400)
  t.check('同一文件重复请求：不重新读盘、不重复视图', [(await t.events()).filter((e) => e === 'view:/repo/docs/guide.md').length, await t.count(TAB('/repo/docs/guide.md')), await t.count('[data-testid="file-tab-pane"][data-path="/repo/docs/guide.md"]')], [viewsBefore, 1, 1])
  await t.act('requestOpen', '/repo/src/missing.ts')
  t.ok('请求不存在的文件：内容区显示打不开和重试', await t.waitFor(`${ACTIVE} [data-testid="file-viewer-error"]`))
  await t.act('requestOpen', '/repo/README.md')
  t.ok('出错后再请求其他文件：恢复正常', await t.waitUntil(`document.querySelector('${PREVIEW}')?.textContent.includes('Hello Pi')`))

  // —— Markdown 链接：点了不能把应用导航走 ——
  await t.js(`window.__linkAlive = 'alive'; window.__hrefBefore = location.href`)
  const appIntact = async (label) =>
    t.ok(label, await t.js(`window.__linkAlive === 'alive' && location.href === window.__hrefBefore`))
  const toasts = () => t.js(`[...document.querySelectorAll('.ant-message-notice')].map((n) => n.textContent).join('|')`)
  const clickLink = async (text) => {
    const found = await t.js(`(() => {
      document.querySelectorAll('[data-probe-link]').forEach((n) => n.removeAttribute('data-probe-link'))
      const el = [...document.querySelectorAll('${PREVIEW} a')].find((a) => a.textContent === ${JSON.stringify(text)})
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.setAttribute('data-probe-link', '1')
      return true
    })()`)
    if (!found) {
      t.ok(`预览里有链接「${text}」`, false)
      return
    }
    await t.sleep(80)
    await t.click('[data-probe-link="1"]', 4)
  }
  const previewHas = (text) => t.waitUntil(`document.querySelector('${PREVIEW}')?.textContent.includes(${JSON.stringify(text)})`)

  const backToLinks = async () => {
    await t.act('requestOpen', '/repo/docs/links.md')
    t.ok('打开链接文档 docs/links.md', await previewHas('Links doc'))
  }
  await backToLinks()
  await clickLink('guide')
  t.ok('相对链接：打开 docs/guide.md', await previewHas('Read me.'))
  t.ok('相对链接：文件树选中 guide.md', await t.waitUntil(`document.querySelector('${TREE} [data-tree-row][data-selected="true"]')?.textContent.includes('guide.md')`))
  await appIntact('相对链接：应用没有被导航走')
  await clickLink('home')
  t.ok('../ 链接：从 docs/guide.md 回到根目录的 README', await previewHas('Hello Pi'))
  await backToLinks()
  await clickLink('readme')
  t.ok('../ 链接：links.md 指向上一级的 README', await previewHas('Hello Pi'))
  await backToLinks()
  await clickLink('spaced')
  t.ok('含空格 + query + hash 的链接：打开 my notes.md', await previewHas('Spaced note'))
  await backToLinks()

  await clickLink('web')
  t.ok('外链：内置浏览器新开标签', await t.waitUntil(`(window.__uiData?.browserUrls ?? []).includes('https://example.com/page')`))
  await appIntact('外链：应用没有被导航走')
  await clickLink('web')
  t.check('外链再点一次：同地址不重复开', (await t.data()).browserUrls, ['https://example.com/page'])
  const ctrl = await t.js(`(() => { const a = [...document.querySelectorAll('${PREVIEW} a')].find((n) => n.textContent === 'web'); a.setAttribute('data-probe-link', '1'); return true })()`)
  t.ok('找到外链', ctrl)
  await t.click('[data-probe-link="1"]', 4, ['control'])
  t.ok('Ctrl 点击外链：交给系统浏览器', await t.waitUntil(`window.__uiEvents.includes('system-open:https://example.com/page')`))

  await clickLink('gone')
  t.ok('不存在的文件：提示找不到', await t.waitUntil(`document.body.textContent.includes('找不到链接指向的文件')`))
  t.ok('不存在的文件：当前文档不动', (await t.js(`document.querySelector('${PREVIEW}')?.textContent.includes('Links doc')`)))
  await clickLink('outside')
  t.ok('项目之外：提示已拦截', await t.waitUntil(`document.body.textContent.includes('项目之外')`))
  await clickLink('mail')
  t.ok('不支持的协议：提示', await t.waitUntil(`document.body.textContent.includes('mailto')`))
  await clickLink('dir')
  t.ok('目录链接：提示并在树里展开', await t.waitUntil(`document.body.textContent.includes('是目录')`))
  await appIntact('这些失败链接也没有把应用导航走')

  const scrollTopOf = () => t.js(`document.querySelector('${PREVIEW}').scrollTop`)
  const scrollBefore = await scrollTopOf()
  await clickLink('jump')
  t.ok('锚点：预览滚到「Sub Heading」', await t.waitUntil(`document.querySelector('${PREVIEW}').scrollTop > ${scrollBefore} + 100`))
  const headTop = await t.js(`(() => { const h = [...document.querySelectorAll('${PREVIEW} h2')].find((n) => n.textContent === 'Sub Heading'); return Math.round(h.getBoundingClientRect().top - document.querySelector('${PREVIEW}').getBoundingClientRect().top) })()`)
  t.ok('锚点：标题停在预览顶部附近', headTop >= 0 && headTop < 60)
  await appIntact('锚点：应用没有被导航走')
  await t.shot('markdown-links')

  // —— 工具栏：面包屑紧凑 + 后退 / 前进 / 刷新 ——
  const bars = await t.js(`(() => {
    const bar = document.querySelector('${ACTIVE} [data-testid="file-viewer-toolbar"]').getBoundingClientRect()
    const crumb = document.querySelector('${ACTIVE} [data-testid="file-viewer-path"]')
    const actions = document.querySelector('${ACTIVE} [data-testid="file-save"]').getBoundingClientRect()
    return { bar: Math.round(bar.width), crumb: Math.round(crumb.getBoundingClientRect().width), clipped: crumb.scrollWidth > crumb.clientWidth, actionsRight: Math.round(bar.right - actions.right) }
  })()`)
  t.info('面包屑 / 工具栏宽度', bars)
  t.ok('面包屑只占自己需要的宽度（不铺满工具栏）', bars.crumb < bars.bar / 3)
  t.check('面包屑：短路径没有被截', bars.clipped, false)
  t.ok('工具栏右侧的保存 / 模式按钮靠右对齐', bars.actionsRight < 80)
  const navDisabled = (id) => t.js(`document.querySelector('${ACTIVE} [data-testid="${id}"]').disabled`)
  t.check('后退可用（前面打开过别的文件）', await navDisabled('file-nav-back'), false)
  t.check('前进不可用（在历史末尾）', await navDisabled('file-nav-forward'), true)
  await t.click(`${ACTIVE} [data-testid="file-nav-back"]`, 8)
  t.ok('后退：回到上一个文件 my notes.md', await previewHas('Spaced note'))
  t.check('后退后前进可用', await navDisabled('file-nav-forward'), false)
  await t.click(`${ACTIVE} [data-testid="file-nav-forward"]`, 8)
  t.ok('前进：回到 links.md', await previewHas('Links doc'))
  t.check('前进到头后前进不可用', await navDisabled('file-nav-forward'), true)
  await t.js(`document.querySelector('${PREVIEW}').focus()`)
  await t.key('Left', ['alt'])
  t.ok('Alt+←：后退', await previewHas('Spaced note'))
  await t.js(`document.querySelector('${PREVIEW}').focus()`)
  await t.key('Right', ['alt'])
  t.ok('Alt+→：前进', await previewHas('Links doc'))

  // 鼠标侧键：sendInputEvent 只支持左 / 中 / 右键，发不出 button 3 / 4，这里在面板上派发等价的 DOM 事件。
  // （Windows 真实侧键还会经主进程 app-command 送达，那条路由单测覆盖，场景里没有主进程。）
  const sideButton = (type, button) =>
    t.js(`(() => { const root = document.querySelector('[data-testid="file-explorer"]'); const e = new MouseEvent('${type}', { bubbles: true, cancelable: true, button: ${button} }); root.dispatchEvent(e); return e.defaultPrevented })()`)
  t.check('侧键按下要阻止默认行为', await sideButton('mousedown', 3), true)
  await sideButton('mouseup', 3)
  t.ok('鼠标后退侧键：后退', await previewHas('Spaced note'))
  await t.sleep(300)
  await sideButton('mouseup', 4)
  t.ok('鼠标前进侧键：前进', await previewHas('Links doc'))
  await t.sleep(300)

  // 刷新：磁盘变了但监听没推事件时，点「刷新」才看得到（文件内容 + 文件树）。
  await t.act('requestOpen', '/repo/docs/my notes.md')
  t.ok('打开 my notes.md', await previewHas('Spaced note'))
  await t.act('silentEdit', '/repo/docs/my notes.md', '# Spaced note\n\nrefreshed from disk\n')
  await t.act('silentEdit', '/repo/src/silent-added.ts', 'export {}\n')
  await t.sleep(400)
  t.ok('没点刷新时还是旧内容', !(await t.js(`document.querySelector('${PREVIEW}').textContent.includes('refreshed from disk')`)))
  await t.click(`${ACTIVE} [data-testid="file-nav-refresh"]`, 8)
  t.ok('刷新：文件内容重新读盘', await previewHas('refreshed from disk'))
  t.ok('刷新：文件树里出现新文件', await t.waitUntil(`${treeTitles}.includes('silent-added.ts')`))
  await t.act('silentEdit', '/repo/src/silent-added.ts', 'export const later = 1\n')
  await t.js(`document.querySelector('${PREVIEW}').focus()`)
  await t.key('F5')
  t.ok('F5 也能刷新（刷新按钮转圈后结束）', await t.waitUntil(`document.querySelector('${ACTIVE} [data-testid="file-nav-refresh"]').getAttribute('aria-busy') === 'false'`))
  await backToLinks()

  // —— 路径栏 ——
  const pathAttr = () => t.js(`document.querySelector('[data-testid="file-path-text"]').getAttribute('data-full-path')`)
  t.check('路径栏：选中项显示相对项目根的路径', await pathAttr(), 'docs/links.md')
  const appTs = await treeNode(t, 'app.ts')
  t.ok('树里有 app.ts', Boolean(appTs))
  await t.hover(appTs)
  t.check('路径栏：悬停某行显示该行路径', await pathAttr(), 'src/app.ts')
  await t.hover('[data-testid="file-path-bar"]')
  t.check('路径栏：鼠标移到路径栏上仍是悬停项（可复制）', await pathAttr(), 'src/app.ts')
  // t.click 点完会把鼠标移开（真实操作里鼠标停在栏上），所以每次点之前重新悬停到 app.ts 再移到路径栏。
  await t.click('[data-testid="file-path-mode"]', 8)
  t.check('路径栏：偏好切到绝对路径', await t.js(`document.querySelector('[data-testid="file-path-mode"]').dataset.mode`), 'absolute')
  await t.hover(appTs)
  t.check('路径栏：绝对路径下悬停项写成绝对路径', await pathAttr(), '/repo/src/app.ts')
  await t.hover('[data-testid="file-path-bar"]')
  await t.click('[data-testid="file-path-copy"]', 8)
  t.ok('路径栏：复制后图标换成已复制', await t.waitUntil(`document.querySelector('[data-testid="file-path-copy"]').getAttribute('aria-label') === '复制路径' && !!document.querySelector('[data-testid="file-path-copy"] .lucide-check')`))
  try {
    t.check('路径栏：剪贴板里是栏里显示的这一行', await t.js(`navigator.clipboard.readText()`), '/repo/src/app.ts')
  } catch (err) {
    t.info('离屏模式读不到剪贴板，跳过内容核对', String(err))
  }
  await t.mouse(2, 2)
  t.check('路径栏：鼠标离开文件树面板回到选中项', await pathAttr(), '/repo/docs/links.md')

  const { longFile } = await t.data()
  await t.act('requestOpen', longFile)
  t.ok('长路径文件打开', await t.waitUntil(`document.querySelector('${TREE} [data-tree-row][data-selected="true"]')?.textContent.includes('deeply-nested-file-name.ts')`))
  const clip = await t.js(`(() => {
    const bar = document.querySelector('[data-testid="file-path-bar"]').getBoundingClientRect()
    const pane = document.querySelector('[data-testid="file-explorer-tree"]').getBoundingClientRect()
    const dir = document.querySelector('[data-testid="file-path-text"] > span:first-child')
    const name = document.querySelector('[data-testid="file-path-text"] > span:last-child')
    return { overflowsPane: bar.right > pane.right + 1, dirClipped: dir.scrollWidth > dir.clientWidth, nameClipped: name.scrollWidth > name.clientWidth }
  })()`)
  t.check('窄栏长路径：路径栏不撑出面板', clip.overflowsPane, false)
  t.check('窄栏长路径：省略号只吃目录部分', [clip.dirClipped, clip.nameClipped], [true, false])
  await t.hover('[data-testid="file-path-text"]')
  t.ok('窄栏长路径：悬停显示完整路径', await t.waitUntil(`[...document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')].some((n) => n.textContent.includes('/repo/docs/long-directory-name-that-keeps-going-and-going/deeply-nested-file-name.ts'))`))
  await t.click('[data-testid="file-path-mode"]', 8)
  t.check('路径偏好切回相对', await pathAttr(), 'docs/long-directory-name-that-keeps-going-and-going/deeply-nested-file-name.ts')

  // —— 窄面板（右栏拖到最窄）：文件树和内容区一次只显示一个 ——
  const visibleTree = isVisible('[data-testid="file-explorer-tree"]')
  const prevSize = await t.resize(380, 880)
  t.ok('窄面板：打开着文件时只显示内容，文件树收成边条', await t.waitUntil(`!document.querySelector('[data-testid="file-explorer-tree"]') && ${isVisible(`${ACTIVE} [data-testid="file-viewer"]`)}`))
  await t.click('[data-testid="file-explorer-tree-toggle"]', 8)
  t.ok('窄面板：点边条切到文件树，内容区藏起（不卸载）', await t.waitUntil(`${visibleTree} && !${isVisible(`${ACTIVE} [data-testid="file-viewer"]`)} && !!document.querySelector('${ACTIVE} [data-testid="file-viewer"]')`))
  const widths = await t.js(`(() => ({ tree: Math.round(document.querySelector('[data-testid="file-explorer-tree"]').getBoundingClientRect().width), root: Math.round(document.querySelector('[data-testid="file-explorer"]').getBoundingClientRect().width) }))()`)
  t.checkNear('窄面板：文件树占满整行', widths.tree, widths.root, 3)
  t.check('窄面板：没有拖拽分隔条', await t.count('[data-testid="file-explorer-splitter"]'), 0)
  t.ok('窄面板：路径栏仍在', await t.js(isVisible('[data-testid="file-path-bar"]')))
  await openNode(t, 'README.md')
  t.ok('窄面板：点文件后切到内容区', await t.waitUntil(`!${visibleTree} && ${isVisible(`${ACTIVE} [data-testid="file-viewer"]`)} && document.querySelector('${PREVIEW}')?.textContent.includes('Hello Pi')`))
  const narrowBar = await t.js(`(() => {
    const bar = document.querySelector('${ACTIVE} [data-testid="file-viewer-toolbar"]').getBoundingClientRect()
    const inside = (id) => { const r = document.querySelector('${ACTIVE} [data-testid="' + id + '"]').getBoundingClientRect(); return r.width > 0 && r.left >= bar.left - 1 && r.right <= bar.right + 1 }
    return ['file-nav-back', 'file-nav-forward', 'file-nav-refresh', 'file-save', 'file-mode-switch'].map((id) => [id, inside(id)])
  })()`)
  t.check('窄面板：工具栏所有按钮都在栏内（放不下时折行，不被裁掉）', narrowBar.every(([, ok]) => ok), true)
  await t.shot('narrow-toolbar')
  await t.resize(prevSize[0], prevSize[1])
  t.ok('恢复宽度：文件树和内容区并排', await t.waitUntil(`${visibleTree} && ${isVisible(`${ACTIVE} [data-testid="file-viewer"]`)}`))

  // —— 文件内快速查找（Ctrl+F）——
  const FIND = `${ACTIVE} [data-testid="file-find-bar"]`
  const FCOUNT = `${FIND} [data-testid="find-count"]`
  const FINPUT = `${FIND} [data-testid="find-input"]`
  const hlSize = (name) => t.js(`(() => { const h = CSS.highlights.get('${name}'); return h ? h.size : 0 })()`)
  const countIs = (text) => t.waitUntil(`document.querySelector('${FCOUNT}')?.textContent === '${text}'`)
  const previewCurrentVisible = `(() => {
    const h = CSS.highlights.get('gren-find-current')
    if (!h) return false
    const r = [...h][0].getBoundingClientRect()
    const s = document.querySelector('${PREVIEW}').getBoundingClientRect()
    return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom
  })()`

  // Markdown 预览
  await backToLinks()
  await t.js(`document.querySelector('${PREVIEW}').focus()`)
  await t.key('f', ['control'])
  t.ok('Ctrl+F（焦点在 Markdown 预览）：文件查找栏出现', await t.waitFor(FIND))
  t.check('打开时焦点进查找栏输入框', await t.js(`document.activeElement?.getAttribute('data-testid')`), 'find-input')
  const toolbarBox = await t.rect(`${ACTIVE} [data-testid="file-viewer-toolbar"]`)
  const findBox = await t.rect(FIND)
  const previewBox = await t.rect(PREVIEW)
  t.ok('查找栏在工具栏下面、预览上面，不盖文档', findBox.y >= toolbarBox.y + toolbarBox.h - 1 && previewBox.y >= findBox.y + findBox.h - 1)
  t.ok('控件靠右', (await t.rect(`${FIND} [data-testid="find-input"]`)).x > findBox.x + findBox.w / 2)
  await t.type('Tail line 1')
  t.ok('计数 1 / 11（Tail line 1 和 10~19）', await countIs('1 / 11'))
  t.check('预览里 11 处都高亮', await hlSize('gren-find'), 11)
  t.ok('当前项在预览底部：滚到可见区域', await t.waitUntil(previewCurrentVisible))
  t.ok('预览确实滚动了', (await t.js(`document.querySelector('${PREVIEW}').scrollTop`)) > 500)
  t.check('不改 DOM：没有 mark', await t.js(`document.querySelectorAll('${PREVIEW} mark').length`), 0)
  await t.key('Enter')
  t.ok('Enter 下一个', await countIs('2 / 11'))
  await t.key('Enter', ['shift'])
  await t.key('Enter', ['shift'])
  t.ok('第 1 处再 Shift+Enter：循环到 11 / 11', await countIs('11 / 11'))
  t.ok('循环后当前项可见', await t.waitUntil(previewCurrentVisible))
  await t.type('9')
  t.ok('输入变化：“Tail line 19”只有 1 处，回到 1 / 1', await countIs('1 / 1'))
  await t.key('a', ['control'])
  await t.type('nothing-here')
  t.ok('无结果：无结果、跳转置灰、高亮清空', await t.waitUntil(`document.querySelector('${FCOUNT}').textContent === '无结果' && document.querySelector('${FIND} [data-testid="find-next"]').disabled && !CSS.highlights.get('gren-find')`))
  await t.key('a', ['control'])
  await t.type('Sub Heading')
  t.ok('换查询再查：Sub Heading 1 / 1', await countIs('1 / 1'))
  await t.shot('file-find-preview')
  await t.key('Escape')
  t.ok('Esc：查找栏消失、高亮清掉', await t.waitUntil(`!document.querySelector('${FIND}') && !CSS.highlights.get('gren-find')`))
  t.ok('Esc：焦点回到打开前的预览区', await t.waitUntil(`document.activeElement?.getAttribute('data-testid') === 'file-markdown-preview'`))

  // 代码编辑器（CodeMirror）
  await openNode(t, 'app.ts')
  t.ok('app.ts 打开', await t.waitUntil(`${docText}.startsWith('export function add')`))
  const docBeforeFind = await t.js(docText)
  await t.click(CONTENT, 40)
  await t.key('f', ['control'])
  t.ok('Ctrl+F（焦点在代码编辑器）：文件查找栏出现，不是 CodeMirror 默认面板', (await t.waitFor(FIND)) && (await t.count('.cm-search')) === 0)
  t.check('焦点在查找栏输入框', await t.js(`document.activeElement?.getAttribute('data-testid')`), 'find-input')
  await t.type('number')
  t.ok('计数 1 / 2', await countIs('1 / 2'))
  t.ok('编辑器里两处都高亮，当前项单独一层', await t.waitUntil(`document.querySelectorAll('${EDITOR} .cm-searchMatch').length === 2 && document.querySelectorAll('${EDITOR} .cm-searchMatch-selected').length === 1`))
  const cmColors = await t.js(`(() => ({ hit: getComputedStyle(document.querySelector('${EDITOR} .cm-searchMatch:not(.cm-searchMatch-selected)')).backgroundColor, current: getComputedStyle(document.querySelector('${EDITOR} .cm-searchMatch-selected')).backgroundColor }))()`)
  t.info('编辑器高亮计算色', cmColors)
  t.ok('编辑器：当前项和其他命中颜色不同且都不是透明', cmColors.hit !== cmColors.current && cmColors.hit !== 'rgba(0, 0, 0, 0)' && cmColors.current !== 'rgba(0, 0, 0, 0)')
  const selectedText = () => t.js(`document.querySelector('${EDITOR} .cm-searchMatch-selected')?.textContent`)
  t.check('当前项就是编辑器里的选区', await selectedText(), 'number')
  await t.key('Enter')
  t.ok('Enter → 2 / 2', await countIs('2 / 2'))
  await t.key('Enter')
  t.ok('第 2 处再 Enter：循环到 1 / 2', await countIs('1 / 2'))
  t.check('编辑器只读：查找不改文档', await t.js(docText), docBeforeFind)
  await t.key('Escape')
  t.ok('Esc：查找栏消失、编辑器高亮清掉', await t.waitUntil(`!document.querySelector('${FIND}') && document.querySelectorAll('${EDITOR} .cm-searchMatch').length === 0`))
  t.ok('Esc：焦点回到编辑器', await t.waitUntil(`document.activeElement?.closest('${EDITOR}') !== null`))

  // 打开着查找栏切文件：用同一查询在新文件里重新查
  await t.key('f', ['control'])
  await t.waitFor(FIND)
  await t.type('line')
  await countIs('1 / 1').then(() => {})
  await openNode(t, 'README.md')
  t.ok('切到 README（预览）：查询保留、结果重算（“Edited line” 1 处）', (await t.waitUntil(`document.querySelector('${PREVIEW}')?.textContent.includes('Hello Pi')`)) && (await countIs('1 / 1')))
  t.check('换文件后查询还在', await t.js(`document.querySelector('${FINPUT}').value`), 'line')
  t.check('预览里有高亮', await hlSize('gren-find'), 1)
  await t.key('Escape')
  await t.waitUntil(`!document.querySelector('${FIND}')`)

  // 图片：不支持查找，Ctrl+F 不拦
  await openNode(t, 'logo.svg')
  t.ok('logo.svg 显示', await t.waitUntil(`document.querySelector('${ACTIVE} [data-testid="file-image-preview"] img')?.naturalWidth > 0`))
  await t.js(`document.querySelector('${ACTIVE} [data-testid="file-viewer"]').focus()`)
  await t.key('f', ['control'])
  await t.sleep(300)
  t.check('图片：Ctrl+F 不弹查找栏', await t.count(FIND), 0)
  await openNode(t, 'README.md')
  await t.waitUntil(`document.querySelector('${PREVIEW}')?.textContent.includes('Hello Pi')`)

  // —— 文件树右键菜单 ——
  const MENU_ITEMS = '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item'
  const menuLabels = `[...document.querySelectorAll('${MENU_ITEMS}')].map((n) => n.textContent)`
  const menuOpen = `document.querySelectorAll('${MENU_ITEMS}').length === 4`
  const menuClosed = `document.querySelectorAll('${MENU_ITEMS}').length === 0 && !document.querySelector('${TREE} [data-menu-open="true"]')`
  const pickMenu = async (text) => {
    const found = await t.js(`(() => {
      document.querySelectorAll('[data-probe-menu]').forEach((n) => n.removeAttribute('data-probe-menu'))
      const el = [...document.querySelectorAll('${MENU_ITEMS}')].find((n) => n.textContent === ${JSON.stringify(text)})
      if (!el) return false
      el.setAttribute('data-probe-menu', '1')
      return true
    })()`)
    if (!found) {
      t.ok(`菜单里有「${text}」`, false)
      return
    }
    await t.click('[data-probe-menu="1"]', 20)
  }
  const rightClickNode = async (name) => {
    const sel = await treeNode(t, name)
    if (!sel) {
      t.ok(`树里有 ${name}`, false)
      return null
    }
    return t.rightClick(sel, 8)
  }
  const toastHas = (text) => t.waitUntil(`[...document.querySelectorAll('.ant-message-notice')].some((n) => n.textContent.includes(${JSON.stringify(text)}))`)

  const viewsBeforeMenu = (await t.events()).filter((e) => e.startsWith('view:')).length
  const activeBeforeMenu = await t.js(activeTab)
  const at = await rightClickNode('util.json')
  t.ok('右键文件：弹出菜单', await t.waitUntil(menuOpen))
  const labels = await t.js(menuLabels)
  t.info('菜单项', labels)
  t.check('菜单前两项和后两项', [labels[0], labels[2], labels[3]], ['添加到对话', '复制路径', '复制相对路径'])
  t.ok('第二项按平台写「在…中显示」', /显示|文件夹/.test(labels[1]))
  t.check('三组之间两条分隔线', await t.countVisible('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-divider'), 2)
  await t.sleep(300)
  const menuBox = await t.rect('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu')
  t.ok('菜单出现在鼠标右下方', Math.abs(menuBox.x - at.x) <= 12 && menuBox.y >= at.y - 2 && menuBox.y - at.y <= 16)
  t.ok('菜单整个在窗口里', menuBox.right <= (await t.js('innerWidth')) && menuBox.bottom <= (await t.js('innerHeight')))
  t.check('右键的那一行标出来', await t.js(`document.querySelector('${TREE} [data-menu-open="true"] [data-tree-title]')?.textContent`), 'util.json')
  t.check('右键不打开文件、不切标签', [(await t.events()).filter((e) => e.startsWith('view:')).length, await t.js(activeTab)], [viewsBeforeMenu, activeBeforeMenu])
  await t.shot('tree-context-menu')
  await t.key('Escape')
  t.ok('Esc 关掉菜单、行不再标出', await t.waitUntil(menuClosed))

  await rightClickNode('util.json')
  await t.waitUntil(menuOpen)
  await pickMenu('复制相对路径')
  t.ok('复制相对路径：提示里是 src/util.json', await toastHas('已复制：src/util.json'))
  t.ok('点完菜单收起', await t.waitUntil(menuClosed))
  try {
    t.check('复制相对路径：剪贴板内容', await t.js(`navigator.clipboard.readText()`), 'src/util.json')
  } catch (err) {
    t.info('离屏模式读不到剪贴板，跳过内容核对', String(err))
  }
  await rightClickNode('util.json')
  await t.waitUntil(menuOpen)
  await pickMenu('复制路径')
  t.ok('复制路径：提示里是绝对路径', await toastHas('已复制：/repo/src/util.json'))

  await rightClickNode('docs')
  t.ok('右键目录也有菜单', await t.waitUntil(menuOpen))
  await pickMenu(labels[1])
  t.ok('在文件管理器中显示：交给主进程定位这个目录', await t.waitUntil(`window.__uiEvents.includes('reveal:/repo/docs')`))

  await rightClickNode('links.md')
  await t.waitUntil(menuOpen)
  await pickMenu('添加到对话')
  t.ok(
    '添加到对话：输入框收到这个文件（相对路径 + 工作区）',
    await t.waitUntil(`window.__uiEvents.includes('composer:' + ${JSON.stringify(JSON.stringify({ absolute: '/repo/docs/links.md', relative: 'docs/links.md', workspace: '/repo', name: 'links.md', isDirectory: false }))})`),
  )

  await rightClickNode('README.md')
  await t.waitUntil(menuOpen)
  await t.click('[data-testid="file-explorer-tree"] > div:first-child', 30)
  t.ok('点别处关掉菜单', await t.waitUntil(menuClosed))
  t.check('菜单操作都没有打开文件', (await t.events()).filter((e) => e.startsWith('view:')).length, viewsBeforeMenu)

  // —— 文件标签栏 ——
  const TABS = '[data-testid="file-tabs"]'
  const tabsBox = await t.rect(TABS)
  const toolbarTop = await t.rect(`${ACTIVE} [data-testid="file-viewer-toolbar"]`)
  t.ok('标签栏在内容区顶上，工具栏紧接在下面', tabsBox.y < toolbarTop.y && Math.abs(tabsBox.y + tabsBox.h - toolbarTop.y) <= 1)
  t.checkNear('标签栏和内容列同宽', tabsBox.w, (await t.rect('[data-testid="file-viewer-column"]')).w, 1)
  const openTabs = await t.js(tabPaths)
  t.info('打开着的标签', openTabs)
  t.check('每个文件只有一个标签', new Set(openTabs).size, openTabs.length)
  t.check('每个标签各挂一份查看器', await t.count('[data-testid="file-tab-pane"]'), openTabs.length)
  t.check(
    '只有当前标签的查看器看得见',
    await t.js(`[...document.querySelectorAll('[data-testid="file-tab-pane"]')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.dataset.path)`),
    ['/repo/README.md'],
  )

  const { dupGuide } = await t.data()
  await t.act('requestOpen', dupGuide)
  t.ok('同名文件：打开另一个 guide.md', await t.waitUntil(`${activeTab} === '${dupGuide}'`))
  const hints = await t.js(`[...document.querySelectorAll('[data-testid="file-tab"]')].filter((el) => el.querySelector('[data-testid="file-tab-name"]').textContent === 'guide.md').map((el) => el.querySelector('[data-testid="file-tab-hint"]')?.textContent ?? '')`)
  t.check('同名文件：标签后面附上能区分的目录', hints, ['docs', 'long-directory-name-that-keeps-going-and-going'])
  const activeInView = `(() => { const b = document.querySelector('${TABS}').getBoundingClientRect(); const a = document.querySelector('[data-testid="file-tab"][data-active="true"]').getBoundingClientRect(); return a.width > 0 && a.left >= b.left - 1 && a.right <= b.right + 1 })()`
  const tabScroll = () => t.js(`(() => { const b = document.querySelector('${TABS}'); return { scrollWidth: b.scrollWidth, clientWidth: b.clientWidth, scrollLeft: Math.round(b.scrollLeft) } })()`)
  const scrolled = await tabScroll()
  t.info('标签栏滚动', scrolled)
  t.ok('标签多了：标签栏横向滚动，不挤扁标签', scrolled.scrollWidth > scrolled.clientWidth)
  t.check(
    '滚动时没有滚动条占掉标签的高度（只差底边 1px）',
    await t.js(`(() => { const b = document.querySelector('${TABS}'); const tab = b.querySelector('[data-testid="file-tab"]'); return [b.offsetHeight - b.clientHeight, b.clientHeight - tab.offsetHeight] })()`),
    [1, 0],
  )
  t.ok('末尾新开的标签滚进可视区', (await t.waitUntil(activeInView)) && scrolled.scrollLeft > 0)
  await t.wheel(TABS, -3000)
  t.ok('滚轮把标签栏横着滚回开头', await t.waitUntil(`document.querySelector('${TABS}').scrollLeft === 0`))
  await t.click(TAB('/repo/README.md'), 20)
  t.ok('点标签切换', await t.waitUntil(`${activeTab} === '/repo/README.md' && document.querySelector('${PREVIEW}')?.textContent.includes('Hello Pi')`))
  await t.act('requestOpen', dupGuide)
  t.ok('切到滚在外面的标签：标签栏自己滚过去', await t.waitUntil(`${activeTab} === '${dupGuide}' && ${activeInView}`))
  t.check('标签栏滚动不带动整个面板', await t.js(`document.querySelector('[data-testid="file-explorer"]').parentElement.scrollTop`), 0)

  // 中键关闭：t.click 只发左键，这里直接发真实的中键按下 / 抬起。
  await t.js(`document.querySelector('${TABS}').scrollLeft = 0`)
  await t.sleep(100)
  const binTab = await t.rect(TAB('/repo/app.bin'))
  const mid = { x: Math.round(binTab.x + 20), y: Math.round(binTab.y + binTab.h / 2) }
  t.win.webContents.sendInputEvent({ type: 'mouseDown', x: mid.x, y: mid.y, button: 'middle', clickCount: 1 })
  t.win.webContents.sendInputEvent({ type: 'mouseUp', x: mid.x, y: mid.y, button: 'middle', clickCount: 1 })
  t.ok('中键关掉 app.bin 的标签', await t.waitUntil(`!${tabPaths}.includes('/repo/app.bin')`))
  t.check('中键关别的标签：当前标签不变', await t.js(activeTab), dupGuide)
  await t.sleep(100)
  t.check('中键关别的标签：标签栏停在原处，不跳回当前标签', await t.js(`document.querySelector('${TABS}').scrollLeft`), 0)

  // 右键菜单
  const menuItem = async (text) => {
    const found = await t.js(`(() => {
      document.querySelectorAll('[data-probe-menu]').forEach((n) => n.removeAttribute('data-probe-menu'))
      const el = [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].find((n) => n.textContent === ${JSON.stringify(text)})
      if (!el) return false
      el.setAttribute('data-probe-menu', '1')
      return true
    })()`)
    return found ? '[data-probe-menu="1"]' : null
  }
  await t.click(TAB('/repo/README.md'), 20)
  await t.waitUntil(`${activeTab} === '/repo/README.md'`)
  await t.rightClick(TAB('/repo/README.md'), 20)
  t.ok('右键标签：弹出菜单', await t.waitUntil(`document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').length === 4`))
  await t.shot('tab-context-menu')
  const closeOthers = await menuItem('关闭其他')
  t.ok('菜单里有「关闭其他」', Boolean(closeOthers))
  await t.click(closeOthers, 20)
  t.ok('关闭其他：只剩 README', await t.waitUntil(`${tabPaths}.join() === '/repo/README.md' && ${activeTab} === '/repo/README.md'`))
  t.check('关掉的标签不再挂着查看器', await t.count('[data-testid="file-tab-pane"]'), 1)
  t.ok('菜单收起', await t.waitUntil(`document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden)').length === 0`))
  await t.rightClick(TAB('/repo/README.md'), 20)
  await t.waitUntil(`document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').length === 4`)
  await t.click(await menuItem('全部关闭'), 20)
  t.ok('全部关闭：标签栏消失，内容区回到提示', await t.waitUntil(`!document.querySelector('${TABS}') && document.querySelector('[data-testid="file-viewer"]')?.textContent.includes('从右边选一个文件查看')`))
  t.check('全部关闭：文件树里没有选中项', await t.count(`${TREE} [data-tree-row][data-selected="true"]`), 0)
  await openNode(t, 'README.md')
  t.ok('再点文件：重新开出标签', await t.waitUntil(`${tabPaths}.join() === '/repo/README.md' && document.querySelector('${PREVIEW}')?.textContent.includes('Hello Pi')`))
  await openNode(t, 'crlf.txt')
  await t.waitUntil(`${activeTab} === '/repo/crlf.txt'`)
  const tabColors = async () =>
    t.js(`(() => {
      const bg = (el) => getComputedStyle(el).backgroundColor
      return { bar: bg(document.querySelector('${TABS}')), active: bg(document.querySelector('[data-testid="file-tab"][data-active="true"]')), toolbarBg: bg(document.querySelector('[data-testid="file-explorer"]')) }
    })()`)
  const darkTabs = await tabColors()
  t.info('深色标签栏颜色', darkTabs)
  t.ok('深色：当前标签和标签栏底色不同、和内容区同色', darkTabs.active !== darkTabs.bar && darkTabs.active === darkTabs.toolbarBg)
  await t.shot('tabs-dark')

  await t.shot('dark')
  await t.setTheme('light')
  await t.mouse(2, 2)
  const lightTabs = await tabColors()
  t.info('浅色标签栏颜色', lightTabs)
  t.ok('浅色：当前标签和标签栏底色不同、和内容区同色，跟着主题变', lightTabs.active !== lightTabs.bar && lightTabs.active === lightTabs.toolbarBg && lightTabs.active !== darkTabs.active)
  await rightClickNode('README.md')
  await t.waitUntil(menuOpen)
  await t.sleep(300)
  const menuBg = (await t.style('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu', ['background-color'])).backgroundColor
  t.info('浅色右键菜单底色', menuBg)
  const menuLum = (menuBg.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number)
  t.ok('浅色：右键菜单是浅底', menuLum.length === 3 && menuLum.every((c) => c > 200))
  await t.shot('tree-context-menu-light')
  await t.key('Escape')
  await t.waitUntil(menuClosed)
  const selected = await t.style(`${TREE} [data-tree-row][data-selected="true"]`, ['color'])
  t.info('选中项文字颜色', selected)
  t.ok('选中项是浅底色、文字不是反白', selected.color !== 'rgb(255, 255, 255)')
  await t.shot('light')
}
