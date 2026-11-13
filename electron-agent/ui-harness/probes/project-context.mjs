export default async function (t) {
  await t.waitForText('[role="alert"]', '索引服务暂不可用')
  await t.click('button[aria-label="重新加载项目数据"]')
  await t.waitForText('section', '48 个节点 · 75 条边')
  const text = await t.text('section')
  t.ok('显示工作区和索引文件数', text.includes('D:/demo/project') && text.includes('12 个文件'))
  t.ok('面板没有 Wiki 区块', !text.includes('Wiki'))
  t.check('只查询当前工作区的索引状态', JSON.stringify(await t.events()), JSON.stringify([
    'agentData_code_status:D:/demo/project',
    'agentData_code_status:D:/demo/project',
  ]))
  await t.shot('project-context')
}
