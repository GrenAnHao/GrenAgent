const texts = (t, selector) => t.js(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((element) => element.textContent)`)
const queryCount = async (t) => (await t.events()).filter((event) => event === 'registry-list').length

export default async function (t) {
  const expected = await t.data()
  await t.waitFor('#history-cards [data-testid="subagent-inline"]')
  t.check('历史：两张单卡和组合卡共享一次 registry 查询', await queryCount(t), 1)
  await t.act('releaseRegistry')
  await t.waitForText('#history-cards', expected.titles[0])
  await t.waitForText('#history-cards', 'group-a')
  await t.waitForText('#history-cards', '中转站 / ')
  t.check('历史：缺标题的完成卡按保存的 agentId 恢复任务', await texts(t, '[data-testid="conv-strip-role"]'), expected.titles)
  t.check('历史：单卡恢复实际模型和思考档位，模型前带供应商显示名', await texts(t, '[data-testid="conv-strip-model"]'), expected.models)
  t.check('历史：重复任务按 agentId 恢复对应模型，没有显示名的供应商用 id', await texts(t, '[data-testid="subagent-step-model"]'), expected.groupModels)
  t.check('历史：没有借用同名其他子代理模型', (await t.text('#history-cards')).includes('wrong-model'), false)
  t.check('历史：完成卡没有运行转圈', await t.count('[data-role="run-spinner"]'), 0)
  await t.shot('history-restored')

  await t.click('#reopen-history')
  await t.waitForText('#history-cards', expected.titles[0])
  await t.waitForText('#history-cards', 'group-a')
  t.check('重开：再次共享一次查询', await queryCount(t), 2)
  t.check('重开：标题不依赖上次挂载的内存', await texts(t, '[data-testid="conv-strip-role"]'), expected.titles)
  t.check('重开：模型和档位不依赖上次挂载的内存', await texts(t, '[data-testid="conv-strip-model"]'), expected.models)
  await t.sleep(2700)
  t.check('终态：首包补齐后释放轮询', await queryCount(t), 2)
  await t.shot('history-reopened')

  await t.click('#show-empty-arrays')
  await t.waitFor('#empty-array-cards')
  const inline = (id) => `#${id} [data-testid="subagent-inline"]`
  const groupRows = (id) => `#${id} [data-testid^="subagent-group-row-"]`
  t.check('空数组：成功单任务保留单卡', await t.count(inline('empty-single')), 1)
  t.check('空数组：拒绝单任务保留单卡', await t.count(inline('empty-rejected')), 1)
  t.check('空数组：chain 两个真实步骤没有消失', await t.count(groupRows('empty-chain')), 2)
  t.check('单步 chain：保留逐项结果和详情索引', await t.count(groupRows('one-step-chain')), 1)
  t.check('混合 task/tasks：两项都显示', await t.count(groupRows('mixed-tasks')), 2)
  const mixedRows = await texts(t, groupRows('mixed-tasks'))
  t.ok('混合 task/tasks：标题按后端顺序显示', mixedRows[0]?.includes('顶层标题') && mixedRows[1]?.includes('数组标题'))
  t.check('混合 task/tasks：模型按后端顺序显示', await texts(t, '#mixed-tasks [data-testid="subagent-step-model"]'), ['中转站 / top', '中转站 / array'])
  t.check('调用级拒绝：组卡直接给出原因', await t.count('#rejected-group [data-testid="subagent-group-error"]'), 1)
  t.ok('调用级拒绝：原因原文没有丢', (await t.text('#rejected-group')).includes('子代理已被禁用'))
  t.check('没有工作：显示错误单卡而非零项组', await t.count(inline('empty-no-work')), 1)
  t.check('后续结果：仍然只有原启动单卡', await t.count(inline('empty-followup')), 1)
  for (const [id, expectedText] of [['empty-single', '空数组成功结果'], ['empty-rejected', '子代理已被禁用'], ['empty-followup', '归并后的最终正文']]) {
    if (await t.count(inline(id))) {
      await t.js(`document.querySelector('#${id}').scrollIntoView({block:'center'})`)
      await t.click(`#${id} button[aria-label="展开"]`)
      t.ok(`${id}：展开可读实际结果`, await t.waitForText(`#${id}`, expectedText))
    }
  }
  t.check('参数流：空数组阶段不显示零项并行卡', await t.count('#stream-cards [data-testid="subagent-group"]'), 0)
  await t.js(`document.querySelector('#advance-stream').scrollIntoView({block:'center'})`)
  await t.click('#advance-stream')
  t.ok('参数流：第一项闭合后可见完整任务', (await t.text('#stream-cards')).includes('流式任务甲'))
  await t.click('#advance-stream')
  t.check('参数流：第二项闭合后显示两个任务', await t.count(groupRows('stream-cards')), 2)
  t.ok('全部：没有持久的零个/零步组头', !/·[ ]*0[ ]*[个步]/.test(await t.text('#empty-array-cards')))
  const error = '#rejected-group [data-testid="subagent-group-error"]'
  const dark = await t.count(error) ? await t.style(error, ['background-color']) : null
  await t.setTheme('light')
  if (dark) {
    const light = await t.style(error, ['background-color'])
    t.ok('浅色：错误底色随主题变化', light.backgroundColor !== dark.backgroundColor)
    const size = await t.style(error, ['max-height', 'overflow-y'])
    t.ok('错误正文高度有上限且可滚动', parseFloat(size.maxHeight) <= 180 && size.overflowY === 'auto')
  }
  await t.js(`document.querySelector('#empty-array-cards').scrollIntoView({block:'start'})`)
  await t.shot('empty-arrays-light')
  await t.js(`document.querySelector('#reopen-history').scrollIntoView({block:'center'})`)
  await t.click('#reopen-history')
  t.check('重挂载：空数组成功任务仍是单卡', await t.count(inline('empty-single')), 1)
  t.check('重挂载：链式步骤完整保留', await t.count(groupRows('empty-chain')), 2)
}
