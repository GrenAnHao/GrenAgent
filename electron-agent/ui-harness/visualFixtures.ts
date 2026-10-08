/**
 * 视觉设计面板的页面 fixture：形状照 show_visual 真实推送的片段
 * （.split 里放 .mockup，底下一段说明，最后是 A / B 两个 data-choice 选项）。
 */

const mockup = (title: string, lines: string[]): string =>
  `<div class="mockup"><div class="mockup-header">${title}</div>` +
  `<div class="mockup-body">${lines.map((line) => `<p>${line}</p>`).join('')}</div></div>`

const filler = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `第 ${i + 1} 行：订单 25100488329${i} · 待发货 · 张** · 共 2 件`)

/** 说明段落：p 在撑满布局里不收缩，段数多了整页就比面板高，只能滚动。 */
const NOTES = Array.from(
  { length: 40 },
  (_, i) => `<p>说明 ${i + 1}：只出现在普通写操作的卡片上，敏感操作永远没有它；这一条故意写得长一点，窄面板里会折成两行。</p>`
).join('\n')

const OPTIONS = `
<h3>这一版可以吗?</h3>
<div class="options">
  <div class="option" data-choice="ok" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content"><h3>可以</h3><p>按这一版写讲规格</p></div>
  </div>
  <div class="option" data-choice="change" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content"><h3>要改</h3><p>提交后在对话里说改哪里</p></div>
  </div>
</div>`

/** 够高：一屏放不下，滚到底才能看到 A / B 两个选项。 */
export function tallHtml(): string {
  return `
<h2>敏感操作确认卡片</h2>
<p class="subtitle">接管 · 主窗口通知卡片：两边谁先点算数</p>
<div class="split">
  ${mockup('接管 · 浏览器窗口：标签拉到前台，顶上亮横幅', filler(7))}
  ${mockup('接管 · 主窗口通知卡片：两边谁先点算数', filler(7))}
</div>
<div class="split">
  ${mockup('暗色主题', filler(6))}
</div>
<p>卡片在前台标签时焦点落在「拒绝」上，Enter 不会批准，批准必须点按钮或 Tab 到按钮再按 Enter；Esc = 拒绝。</p>
<p>60 秒，只显示数字和一条细进度条，最后 10 秒进度条变红。</p>
<p>最多两行，超出省略，悬停看全文；手机号、收件人在卡片上按原样显示（用户要核对），写进审计时才打码。</p>
${NOTES}
${OPTIONS}
`
}

/** 很矮：比面板低得多，比较区应该撑满中间的剩余空间，选项贴在确认条上方。 */
export function shortHtml(): string {
  return `
<h2>敏感操作确认卡片</h2>
<div class="split">
  ${mockup('暗色主题', filler(2))}
</div>
${OPTIONS}
`
}
