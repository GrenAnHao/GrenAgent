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
}
