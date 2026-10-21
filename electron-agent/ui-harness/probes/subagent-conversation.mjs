const list = '[data-testid="child-conversation"]'
const scroll = `${list} > div`

/**
 * 把目标滚到视口中央，等它能被真实指针事件打中。
 * virtua 在外层滚动期间给内层容器设 pointer-events: none，点击和滚轮都会被外层接走；
 * scrollIntoView 之后 scroll 事件下一帧才到，virtua 那时才设 none，只命中一次会抢在这个空档里，
 * 所以要求交互点的命中测试连续 300ms 成立。dx 给了就按 t.click(sel, dx) 的落点测，否则测中心。
 */
async function settleHit(t, sel, dx) {
  await t.js(`document.querySelector('${sel}').scrollIntoView({ block: 'center' }); window.__hitSince = 0`)
  return t.waitUntil(`(() => {
    const el = document.querySelector('${sel}')
    const r = el?.getBoundingClientRect()
    const x = r && (${dx ?? 'null'} == null ? r.left + r.width / 2 : r.left + ${dx ?? 0})
    const hit = !!r && el.contains(document.elementFromPoint(x, r.top + r.height / 2))
    if (!hit) { window.__hitSince = 0; return false }
    window.__hitSince = window.__hitSince || performance.now()
    return performance.now() - window.__hitSince >= 300
  })()`, 4000)
}

/** 贴底时某元素底边到滚动区底边的距离。子代理面板下面没有输入框，末尾要自己留白。 */
async function gapToBottom(t, root, sel) {
  return t.js(`(() => {
    const el = document.querySelector('${root} ${sel}')?.getBoundingClientRect()
    const box = document.querySelector('${root} > div')?.getBoundingClientRect()
    return el && box ? box.bottom - el.bottom : null
  })()`)
}

export default async function (t) {
  const { steps, task, finalText, reasoningLastLine } = await t.data()
  await t.waitForText(list, finalText, 12000)
  const mountedTools = await t.count(`${list} [data-testid="tool-execution"]`)
  t.ok(`长工具循环：只挂载视口附近的工具（${mountedTools}/${steps}）`, mountedTools > 0 && mountedTools < 40)
  t.check('整轮正文：仅一个复制入口', await t.count(`${list} [data-testid="message-action-bar"]`), 1)

  // 终态长思考是唯一排在最后一个工具之后的 reasoning。虚拟列表贴底后它不一定已挂载，
  // 只取「最后一个 reasoning」会拿到 null 或前面的短思考，所以先结束自动贴底，再等它挂上才打标记。
  // 挂载后马上滚：贴底不能留下 virtua 的 scrollToIndex 重滚任务，否则新条目一测高，
  // 这一下滚轮就被拽回底部，或者跳到顶部。
  await t.wheel(scroll, -200)
  await t.js('new Promise((done) => setTimeout(done, 500))')
  const afterWheel = await t.js(`(() => {
    const h = document.querySelector('${scroll}')
    return { top: h.scrollTop, fromBottom: h.scrollHeight - h.scrollTop - h.clientHeight }
  })()`)
  t.ok(
    `挂载后立刻上滚：停在用户滚到的位置（离底 ${Math.round(afterWheel.fromBottom)}px，scrollTop ${Math.round(afterWheel.top)}）`,
    afterWheel.fromBottom >= 100 && afterWheel.fromBottom <= 600 && afterWheel.top > 1000,
  )
  const finalReasonMounted = `(() => {
    const r = Array.from(document.querySelectorAll('${list} [data-testid="reasoning-inline"]')).at(-1)
    const tool = Array.from(document.querySelectorAll('${list} [data-testid="tool-execution"]')).at(-1)
    return !!r && (!tool || Boolean(tool.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING))
  })()`
  await t.waitUntil(finalReasonMounted, 8000)
  await t.js(`Array.from(document.querySelectorAll('${list} [data-testid="reasoning-inline"]')).at(-1).setAttribute('data-case', 'last-reasoning')`)
  const finalReason = `${list} [data-case="last-reasoning"]`
  // 虚拟列表的缓冲条目可能已挂载但仍在视口外，点击前先将目标滚到视口内、等滚动停下。
  t.ok('完成思考：展开按钮滚动停下后可以被点中', await settleHit(t, `${finalReason} button`, 20))
  await t.click(`${finalReason} button`, 20)
  await t.waitForText(finalReason, reasoningLastLine, 12000)
  const body = `${finalReason} [data-testid="reasoning-body"]`
  const geometry = await t.js(`(() => {
    const root = document.querySelector('${finalReason}')
    const el = root?.querySelector('[data-testid="reasoning-body"]') ?? root?.lastElementChild
    if (!el) return null
    const style = getComputedStyle(el)
    return { height: el.clientHeight, maxHeight: style.maxHeight, overflowY: style.overflowY, scrollHeight: el.scrollHeight }
  })()`)
  t.check('完成思考：展开沿用流式 160px 上限', geometry?.maxHeight, '160px')
  t.check('完成思考：正文可以内部滚动', geometry?.overflowY, 'auto')
  t.ok('完成思考：长内容没有撑开整列', geometry != null && geometry.height <= 160 && geometry.scrollHeight > geometry.height)
  if (await t.count(body)) {
    // 展开是向下长的，正文中心可能落在视口外，滚轮事件进不了页面；先把正文本身滚到视口中央。
    t.ok('完成思考：滚动停下后正文可以被指针命中', await settleHit(t, body))
    await t.wheel(body, 1000)
    t.ok('完成思考：真实滚轮推进内部正文', await t.waitUntil(`document.querySelector('${body}').scrollTop > 0`, 1500))
  }
  await t.shot('thinking-expanded')

  await t.wheel(scroll, -40000)
  await t.waitForText(list, task, 5000)
  t.ok('历史：滚到顶部后任务仍可访问', (await t.text(list))?.includes(task))
  t.ok('历史：顶部同样没有全量挂载工具', (await t.count(`${list} [data-testid="tool-execution"]`)) < 40)
  t.check('历史：底部正文离屏后卸载', (await t.text(list))?.includes(finalText), false)
  await t.shot('history-top')
  await t.click('[data-testid="jump-to-bottom"]', 16)
  await t.waitForText(list, finalText, 5000)
  t.ok('回到底部：最终正文重新显示', (await t.text(list))?.includes(finalText))
  t.check('回到底部：无错误边界降级', await t.count('[data-testid="error-boundary-fallback"]'), 0)
  // 留白下面只剩每行自带的 4px paddingBlock：确实贴底，下面的距离断言不是因为没滚到底才成立。
  t.checkNear('回到底部：贴底时末尾留白就是最后一行', await gapToBottom(t, list, '[data-testid="subagent-tail-space"]'), 4, 2)
  t.ok('回到底部：最后一行离面板底边留出空白', (await gapToBottom(t, list, '[data-testid="message-action-bar"]')) >= 90)
  await t.shot('long-bottom')

  await t.click('[data-testid="show-spacing"]', 30)
  await t.waitForText('[data-testid="child-spacing"]', '间距对照结束。', 12000)
  const spacing = await t.js(`(() => {
    const offsets = (id) => Array.from(document.querySelectorAll('[data-testid="' + id + '"] [data-testid="tool-execution"]'), el => el.getBoundingClientRect().top)
    const main = offsets('main-spacing')
    const child = offsets('child-spacing')
    return { main: main[1] - main[0], child: child[1] - child[0], mainCount: main.length, childCount: child.length }
  })()`)
  t.check('间距对照：两列均渲染三条工具', [spacing.mainCount, spacing.childCount], [3, 3])
  t.checkNear('子代理：思考与工具行距和主对话一致', spacing.child, spacing.main, 0.5)
  await t.shot('compact-row-spacing')

  await t.click('[data-testid="show-live"]', 30)
  const live = '[data-testid="subagent-live-spawn"]'
  await t.waitForText(live, (await t.data()).liveTask, 12000)
  await t.act('startLive')
  const preview = `${live} [data-testid="reasoning-stream-text"]`
  await t.waitForText(preview, (await t.data()).livePrefix, 5000)
  t.ok('后台子代理：启动工具已返回仍显示正在深度思考', (await t.text(live)).includes('正在深度思考'))
  t.check('折叠思考：只显示外部单行预览', await t.count(`${live} [data-testid="reasoning-stream-body"]`), 0)
  const offsets = await t.sample(`(() => {
    const el = document.querySelector('${preview} > span')
    return el ? -new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 : null
  })()`, 600, () => t.act('appendLive'))
  const values = offsets.filter((value) => typeof value === 'number')
  t.ok('折叠思考：追加文字时外部预览持续滑动', values.length > 3 && values.at(-1) > values[0] + 20 && new Set(values).size > 3)
  t.ok('折叠思考：滑动方向连续向最新内容推进', values.every((value, i) => i === 0 || value >= values[i - 1] - 0.1))
  t.check('折叠思考：预览保持单行裁切', (await t.style(preview, ['white-space', 'overflow-x'])), { whiteSpace: 'nowrap', overflowX: 'hidden' })
  // 这一段内容填不满面板，量不到「离底边多远」；只确认「正在处理」下面跟着末尾留白。
  const pendingTail = await t.js(`(() => {
    const pending = document.querySelector('${live} [data-testid="pending-response"]')?.getBoundingClientRect()
    const tail = document.querySelector('${live} [data-testid="subagent-tail-space"]')?.getBoundingClientRect()
    return pending && tail ? tail.bottom - pending.bottom : null
  })()`)
  t.ok(`运行中：「正在处理」下面留出末尾空白（${pendingTail}px）`, pendingTail >= 90)
  await t.shot('live-thinking-preview')
  const liveReason = `${live} [data-testid="reasoning-inline"]`
  await t.click(`${liveReason} button`, 20)
  await t.waitFor(`${live} [data-testid="reasoning-stream-body"]`)
  t.check('流式思考：展开正文仍限制 160px', (await t.style(`${live} [data-testid="reasoning-stream-body"]`, ['max-height'])).maxHeight, '160px')
  await t.click(`${liveReason} button`, 20)
  await t.waitFor(preview)
  t.check('流式思考：再次折叠后恢复外部预览', await t.count(preview), 1)
  await t.act('finishLive')
  await t.waitForText(liveReason, '已深度思考', 5000)
  await t.waitUntil(`document.querySelector('${live} [data-testid="pending-response"]') === null`, 6000)
  t.check('子代理真正完成：停止预览与运行状态', await t.count(`${preview}, ${live} [data-testid="pending-response"]`), 0)

  // 真实后台 spawn 的结果不带 sessionPath，详情只能从登记表轮询拿路径；
  // 完成后最后一个消费者释放轮询，store 清掉这个项目的行，路径不能跟着丢。
  const { livePrefix, nopathTask, nopathFinal, doneTask, doneFinal } = await t.data()
  await t.click('[data-testid="show-nopath"]', 30)
  const np = '[data-testid="subagent-nopath-spawn"]'
  await t.waitForText(np, nopathTask, 12000)
  await t.act('startNopath')
  t.ok('结果不带路径：运行中靠登记表路径接上子会话事件流', await t.waitForText(`${np} [data-testid="reasoning-stream-text"]`, livePrefix, 6000))
  await t.act('finishNopath')
  await t.waitForText(np, nopathFinal, 5000)
  await t.waitUntil(`document.querySelector('${np} [data-testid="pending-response"]') === null`, 8000)
  // 停轮询、清 store、详情重算路径都在同一轮渲染之后，多等一会儿再看有没有退回只剩任务原文。
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.ok('结果不带路径：完成后仍显示子会话正文', (await t.text(np))?.includes(nopathFinal))
  t.ok('结果不带路径：完成后思考仍在', (await t.text(np))?.includes('已深度思考'))
  await t.shot('nopath-finished')

  // 重开会话 / 切回标签：详情挂载时已是终态，不会再起轮询，缺路径时只补查一次。
  const listCalls = async () => (await t.events()).filter((event) => event === 'subagent_list').length
  const before = await listCalls()
  await t.click('[data-testid="show-done-nopath"]', 30)
  const dn = '[data-testid="child-done-nopath"]'
  await t.waitForText(dn, doneTask, 6000)
  t.ok('终态挂载缺路径：补查登记表后显示完整子会话', await t.waitForText(dn, doneFinal, 6000))
  const afterLookup = await listCalls()
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.ok(`终态挂载缺路径：只补查一次，不常驻轮询（${afterLookup - before} → ${(await listCalls()) - before}）`, afterLookup - before >= 1 && (await listCalls()) === afterLookup)
  t.ok('终态挂载缺路径：轮询释放后正文仍在', (await t.text(dn))?.includes(doneFinal))

  // 子代理的 grep 是 pi 内置工具，输出 path:N: text；以前只认 opencode 格式，每条都画成「0 处 / 未找到匹配」。
  await t.click('[data-testid="show-grep"]', 30)
  const gp = '[data-testid="child-grep"]'
  await t.waitForText(gp, '检索完成。', 8000)
  const rows = await t.js(`Array.from(document.querySelectorAll('${gp} [data-testid="tool-execution"]'), (el) => el.textContent)`)
  t.ok(`pi grep：有命中的折叠行写「2 处」（${rows?.[0]}）`, rows?.[0]?.includes('2 处'))
  t.ok(`pi grep：真的没命中才写「0 处」（${rows?.[1]}）`, rows?.[1]?.includes('0 处'))
  await t.js(`document.querySelector('${gp} [data-testid="tool-execution"]').setAttribute('data-case', 'grep-hit')`)
  const hit = `${gp} [data-case="grep-hit"]`
  t.ok('pi grep：行可以被点中', await settleHit(t, hit, 20))
  await t.click(hit, 20)
  t.ok('pi grep：展开后是按文件分组的命中卡', await t.waitFor(`${hit} [data-testid="card-grep"]`, 5000))
  await t.waitForText(`${hit} [data-testid="card-grep"]`, 'export function CodeRetrievalPanel', 8000)
  const card = await t.text(`${hit} [data-testid="card-grep"]`)
  t.ok('pi grep：展开不显示「未找到匹配」', !card?.includes('未找到匹配'))
  t.ok('pi grep：匹配行带行号', card?.includes('39: export function CodeRetrievalPanel'))
  t.ok('pi grep：上下文行用「N-」区分', card?.includes('40- '))
  t.ok('pi grep：上限提示画成已截断', card?.includes('结果较多，已截断显示'))
  await t.shot('pi-grep-expanded')
}
