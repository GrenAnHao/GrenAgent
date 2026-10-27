/**
 * 右侧边栏跟着会话走（真实点击）：
 * - A 里点「右栏」打开启动页，点「文件」开出文件标签；切到 B：右栏收起，B 里重新打开只看到自己的空启动页，
 *   A 的文件标签不在 B 的标签条里。
 * - 切回 A：右栏按 A 离开时的样子展开，标签条里是 A 的文件标签，而且是同一个 body 实例（没被卸载重建）。
 * - 切回 B：B 离开时开着，右栏展开，仍是 B 的空启动页；B 自己开文件标签是另一份，切回 A 看到的还是 A 那份。
 */

const ASIDE = `document.querySelector('[data-testid="right-host"]').closest('aside')`
const STRIP = '[data-testid="dock-strip-right"]'
const LAUNCHER = '[data-testid="dock-launcher-right"]'
const FILE_BODY = '[data-testid^="dock-body-file:right:"]'
const MARKED = '[data-probe-mark="a"]'

const panelWidth = (t) => t.js(`Math.round(${ASIDE}.getBoundingClientRect().width)`)
const settle = () => new Promise((resolve) => setTimeout(resolve, 450))

async function openSession(t, id) {
  await t.click(`[data-testid="session-${id}"]`, 20)
  await t.waitUntil(`document.querySelector('[data-testid="session-${id}"]').dataset.active === 'true'`)
  await settle()
}

export default async function probe(t) {
  // ——— 会话 A：打开右栏，开一个文件标签 ———
  t.checkNear('起点：A 的右栏收起', await panelWidth(t), 0, 2)
  await t.click('[data-testid="toggle-right"]', 10)
  await settle()
  t.ok('A：点「右栏」后面板展开', (await panelWidth(t)) > 300)
  t.check('A：空右栏显示启动页', await t.countVisible(LAUNCHER), 1)
  t.ok('启动页里的入口叫「文件管理器」', (await t.text('[data-testid="dock-launcher-file"]')).includes('文件管理器'))

  await t.click('[data-testid="dock-launcher-file"]', 30)
  await t.waitFor(STRIP)
  await t.waitFor(`${FILE_BODY} [data-testid="file-tree"] [data-tree-title]`)
  t.check('A：标签条里有一个文件标签', await t.countVisible(`${STRIP} [data-testid^="dock-tab-file:right:"]`), 1)
  t.ok('标签条里写「文件管理器」', (await t.text(`${STRIP} [data-testid^="dock-tab-file:right:"]`)).includes('文件管理器'))
  await t.js(`document.querySelector('${FILE_BODY}').dataset.probeMark = 'a'`)

  // ——— 切到 B：A 的右栏不跟过来 ———
  await openSession(t, 'b')
  t.checkNear('B：右栏收起（A 打开的面板没有带进 B）', await panelWidth(t), 0, 2)
  await t.click('[data-testid="toggle-right"]', 10)
  await settle()
  t.ok('B：点「右栏」后面板展开', (await panelWidth(t)) > 300)
  t.check('B：看到的是自己的空启动页', await t.countVisible(LAUNCHER), 1)
  t.check('B：没有 A 的标签条', await t.countVisible(STRIP), 0)
  await t.shot('b-own-launcher')
  t.check('B：A 的文件标签 body 还挂着（终端 / 未保存修改不丢）', await t.count(MARKED), 1)
  t.check('B：A 的文件标签 body 看不见', await t.countVisible(MARKED), 0)

  // ——— 切回 A：恢复 A 的右栏 ———
  await openSession(t, 'a')
  t.ok('A：右栏按离开时的样子展开', (await panelWidth(t)) > 300)
  t.check('A：标签条里是 A 的文件标签', await t.countVisible(`${STRIP} [data-testid^="dock-tab-file:right:"]`), 1)
  t.check('A：文件标签是同一个实例，没有被卸载重建', await t.countVisible(MARKED), 1)
  t.check('A：没有启动页', await t.countVisible(LAUNCHER), 0)
  await t.shot('a-restored')

  // ——— 再到 B：B 离开时开着空右栏；B 自己开的文件标签是另一份 ———
  await openSession(t, 'b')
  t.ok('B：右栏按 B 离开时的样子展开', (await panelWidth(t)) > 300)
  t.check('B：仍是空启动页', await t.countVisible(LAUNCHER), 1)
  await t.click('[data-testid="dock-launcher-file"]', 30)
  await t.waitFor(STRIP)
  t.check('B：自己的文件标签可见', await t.countVisible(FILE_BODY), 1)
  t.check('B：可见的文件标签不是 A 那份', await t.countVisible(MARKED), 0)
  t.check('B：两份文件标签各自挂着', await t.count(FILE_BODY), 2)

  // ——— B 收起右栏，回 A 再回 B：各自记各自的 ———
  await t.click('[title="Collapse panel"]', 6)
  await settle()
  t.checkNear('B：收起右栏', await panelWidth(t), 0, 2)
  await openSession(t, 'a')
  t.ok('A：仍然展开', (await panelWidth(t)) > 300)
  t.check('A：可见的是 A 的那份文件标签', await t.countVisible(MARKED), 1)
  await openSession(t, 'b')
  t.checkNear('B：保持收起（不被 A 的展开状态带开）', await panelWidth(t), 0, 2)

  await t.shot('b-collapsed')
}
