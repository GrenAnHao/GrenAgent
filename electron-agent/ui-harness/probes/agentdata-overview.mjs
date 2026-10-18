/**
 * Agent 数据 · 概览：「最近任务 / 知识库 / 最近记忆」三张卡片内容多少不一，宽屏一行三列时拉到同高、顶边和底边都对齐；
 * 空的知识库卡片里，空状态在标题栏下面剩下的高度里居中。窄视口换成一列时各卡片照常排开，不互相拉高。
 */

const CARD = (name) => `section[aria-label="${name}"]`
const NAMES = ['最近任务', '知识库', '最近记忆']

export default async function (t) {
  t.ok('三张卡片渲染出来', await t.waitFor(CARD('最近记忆')))
  t.ok('记忆卡片有内容', await t.waitFor(`${CARD('最近记忆')} button`))

  const rects = []
  for (const name of NAMES) rects.push(await t.rect(CARD(name)))
  const [tasks, wiki, memory] = rects
  t.ok('宽屏：三张卡片在同一行', tasks.y === wiki.y && wiki.y === memory.y && tasks.x < wiki.x && wiki.x < memory.x)
  t.checkNear('宽屏：知识库卡片和最近任务同高', wiki.h, tasks.h, 1)
  t.checkNear('宽屏：最近记忆卡片和最近任务同高', memory.h, tasks.h, 1)
  t.checkNear('宽屏：知识库底边与最近任务对齐', wiki.bottom, tasks.bottom, 1)
  t.checkNear('宽屏：最近记忆底边与最近任务对齐', memory.bottom, tasks.bottom, 1)
  t.ok('宽屏：卡片高度取最高的那张（不是被压到空卡片的高度）', tasks.h > 200)

  // 空状态在标题栏下面剩下的区域里垂直居中
  const header = await t.js(`(() => {
    const r = document.querySelector('${CARD('知识库')} > div').getBoundingClientRect()
    return Math.round(r.bottom)
  })()`)
  const empty = await t.rect(`${CARD('知识库')} .ant-empty`)
  t.ok('知识库卡片显示空状态', !!empty)
  if (empty) {
    t.checkNear('空状态在剩余高度里垂直居中', empty.y + empty.h / 2, (header + wiki.bottom) / 2, 3)
  }
  await t.shot('wide')

  // —— 窄视口：一列 ——
  const restore = await t.resize(640, 880)
  const narrow = []
  for (const name of NAMES) narrow.push(await t.rect(CARD(name)))
  t.ok('窄视口：三张卡片上下排成一列', narrow[0].x === narrow[1].x && narrow[1].x === narrow[2].x && narrow[0].bottom <= narrow[1].y && narrow[1].bottom <= narrow[2].y)
  t.ok('窄视口：空的知识库卡片不被拉成最近任务那么高', narrow[1].h < narrow[0].h)
  await t.shot('narrow')
  await t.resize(...restore)
}
