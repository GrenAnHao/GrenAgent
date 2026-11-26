const frameOf = (t) => t.win.webContents.mainFrame.framesInSubtree.find((frame) => frame.url === 'about:srcdoc')

async function frame(t, code) {
  const frame = frameOf(t)
  if (!frame) return undefined
  try { return await frame.executeJavaScript(code) } catch { return undefined }
}

async function waitPreview(t, version) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await frame(t, `document.body.textContent.includes('第 ${version} 版预览')`)) return true
    await t.sleep(100)
  }
  return false
}

async function responses(t) {
  return (await t.events()).filter((event) => event.startsWith('respond:')).map((event) => JSON.parse(event.slice('respond:'.length)))
}

export default async function (t) {
  const { firstPreview, secondPreview, thirdPreview, fourthPreview } = await t.data()
  t.ok('版本一预览和询问卡同时展示', await waitPreview(t, 1) && await t.waitFor('[data-testid="inline-question"]'))
  t.check('评审卡起始没有任何选项被选', await t.js(`document.querySelector('[data-testid="inline-question-next"]').disabled`), true)
  t.ok('版本一页面无确认/补充条', await frame(t, `!document.querySelector('#visual-confirm-bar, #visual-note-panel, #visual-confirm-btn')`))
  await t.shot('first-preview-review')

  // The real iframe hit target can select a visual scheme, but never submit a review.
  t.check('预览选项点击仅切换展示', await frame(t, `(() => { const el = document.querySelector('[data-choice="b"]'); el.click(); return el.classList.contains('selected') })()`), true)
  await t.act('legacyMessage')
  t.check('旧 visual-choice 回传与页面点击都不能产生答复', (await responses(t)).length, 0)

  await t.click('[data-testid="inline-question-opt-visual-review-redo"]', 20)
  await t.click('[data-testid="inline-question-next"]', 20)
  t.ok('方案页默认可填自定义答案', await t.waitFor('[data-testid="inline-question-opt-q1-__custom__"]'))
  await t.click('[data-testid="inline-question-opt-q1-__custom__"]', 20)
  t.check('空的自定义答案禁止提交', await t.js(`document.querySelector('[data-testid="inline-question-submit"]').disabled`), true)
  await t.click('[data-testid="inline-question-custom-q1"]', 20)
  await t.type('自定义配色')
  await t.click('[data-testid="inline-question-extra-text"]', 20)
  await t.type('标题再大一点')
  t.check('补充说明通过输入卡提供', await t.js(`document.querySelector('[data-testid="inline-question-extra-text"]').value`), '标题再大一点')
  await t.shot('redo-with-custom-and-supplement')
  await t.click('[data-testid="inline-question-submit"]', 20)
  await t.waitUntil(`(window.__uiEvents ?? []).filter((event) => event.startsWith('respond:')).length === 1`, 5000)
  const first = (await responses(t))[0]
  const firstAnswer = JSON.parse(first.value)
  t.check('打回绑定第一版并保留自定义方案', [first.id, firstAnswer.review, firstAnswer.text.includes('自定义配色'), firstAnswer.text.includes('标题再大一点')], ['request-1', { previewId: firstPreview, outcome: 'redo' }, true, true])

  await t.act('nextVersion')
  t.ok('第二版打开新预览和未选中首题', await waitPreview(t, 2) && await t.waitFor('[data-testid="inline-question-opt-visual-review-approve"]'))
  t.check('第二版仍需明确通过，不能继承打回选择', await t.js(`document.querySelector('[data-testid="inline-question-next"]').disabled`), true)
  t.ok('旧 iframe 不会带来确认条', await frame(t, `!document.querySelector('#visual-confirm-bar, #visual-note-panel, #visual-confirm-btn')`))
  await t.shot('second-preview-review')
  await t.act('park')
  t.check('切到后台：当前询问卡收起且不误答', await t.countVisible('[data-testid="inline-question"]'), 0)
  t.check('后台等待不产生新提交', (await responses(t)).length, 1)
  await t.act('restore')
  t.ok('切回原会话：同一版询问卡恢复', await t.waitFor('[data-testid="inline-question-opt-visual-review-approve"]'))
  await t.click('[data-testid="inline-question-opt-visual-review-approve"]', 20)
  await t.click('[data-testid="inline-question-next"]', 20)
  await t.click('[data-testid="inline-question-opt-q1-a"]', 20)
  await t.click('[data-testid="inline-question-submit"]', 20)
  await t.waitUntil(`(window.__uiEvents ?? []).filter((event) => event.startsWith('respond:')).length === 2`, 5000)
  const second = (await responses(t))[1]
  const secondAnswer = JSON.parse(second.value)
  t.check('第二版独立批准并保留方案', [second.id, secondAnswer.review, secondAnswer.text.includes('方案 A')], ['request-2', { previewId: secondPreview, outcome: 'approved' }, true])
  // A newer preview replaces an unanswered older card; cancellation never approves it.
  await t.act('thirdVersion')
  t.ok('第三版未答评审卡出现', await waitPreview(t, 3) && await t.waitFor('[data-testid="inline-question-opt-visual-review-approve"]'))
  t.check('第三版起始未选中', await t.js(`document.querySelector('[data-testid="inline-question-next"]').disabled`), true)
  await t.act('fourthVersion')
  t.ok('新版替换未答旧版，仍需明确选择', await waitPreview(t, 4) && await t.waitFor('[data-testid="inline-question-opt-visual-review-approve"]'))
  t.check('第三版没有收到批准或打回答复', (await responses(t)).length, 2)
  t.check('第四版首题不继承第三版', await t.js(`document.querySelector('[data-testid="inline-question-next"]').disabled`), true)
  await t.shot('replaced-review')
  await t.click('[data-testid="inline-question-skip"]', 20)
  await t.waitUntil(`(window.__uiEvents ?? []).filter((event) => event.startsWith('respond:')).length === 3`, 5000)
  const cancelled = (await responses(t))[2]
  t.check('新版取消仅回 cancelled，不编码 approval', [cancelled.id, cancelled.cancelled, cancelled.value], ['request-4', true, undefined])
  t.check('旧回传、第三版和取消均未增加批准结果', (await responses(t)).filter((response) => response.value && JSON.parse(response.value).review?.outcome === 'approved').length, 1)
  t.ok('第三、四版身份不同', thirdPreview !== fourthPreview)
}

