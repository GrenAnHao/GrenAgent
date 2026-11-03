export default async function (t) {
  t.ok('Agent 数据中心就绪', await t.waitFor('#agent-data-tab-overview'))
  t.check('概览、Repo Wiki、资料 Wiki、代码索引、任务和审计诊断六个页签', await t.count('[role="tab"]'), 6)
  t.check('Memory 页签已移除', await t.count('#agent-data-tab-memory'), 0)
  t.check('概览没有记忆统计或创建入口', await t.js(`Array.from(document.querySelectorAll('#agent-data-panel-overview button')).filter((button) => /记忆|Memory/.test(button.textContent || '')).length`), 0)

  for (const [tab, panel] of [
    ['wiki', 'wiki-panel'], ['code', 'code-retrieval-panel'],
    ['jobs', 'jobs-panel'], ['audit', 'audit-diagnostics-panel'],
  ]) {
    await t.click(`#agent-data-tab-${tab}`)
    t.ok(`${tab} 功能仍可打开`, await t.waitFor(`[data-testid="${panel}"]`))
    t.check(`${tab} 页签处于选中态`, await t.js(`document.querySelector('#agent-data-tab-${tab}').getAttribute('aria-selected')`), 'true')
  }
  await t.click('#agent-data-tab-overview')
  t.ok('回到概览后新建知识库仍可用', await t.waitFor('#agent-data-panel-overview button.ant-btn-primary'))
  t.check('所有页面切换都不请求已裁撤的 Memory IPC', (await t.events()).filter((event) => event.startsWith('agentData_memory_')).length, 0)
  await t.setTheme('light')
  t.check('浅色主题仍无 Memory 入口', await t.count('#agent-data-tab-memory'), 0)
  await t.shot('light')
}
