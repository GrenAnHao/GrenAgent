const card = (id) => `[data-case="${id}"]`;
const head = (id) => `${card(id)} button`;
const body = (id) => `${card(id)} [data-testid$="-pill-body"]`;
async function open(t, id) {
  await t.js(`document.querySelector('${card(id)}').scrollIntoView({ block: 'center' })`);
  await t.click(head(id), 20);
}
export default async function (t) {
  t.ok('结算时间线加载', await t.waitFor('#task-notices'));
  t.check('默认全部收起，不外铺正文', await t.count('[data-testid="job-done-pill-body"], [data-testid="subagent-settled-pill-body"]'), 0);
  t.check('没有多余类型标签', await t.count('[data-testid="task-notice-chip"]'), 0);
  for (const [id, expected] of [['bash-ok', 'completed'], ['bash-exit', 'failed'], ['bash-failed', 'failed'], ['bash-cancel', 'cancelled'], ['bash-timeout', 'timeout'], ['bash-unknown', 'unknown'], ['sa-done', 'completed'], ['sa-error', 'failed'], ['sa-abort', 'aborted'], ['sa-timeout', 'timeout']]) {
    t.check(`${id} 终态明确且不混淆`, await t.js(`document.querySelector('${card(id)} [data-outcome]').dataset.outcome`), expected);
  }
  t.ok('非零退出头部直接写失败和退出码', (await t.text(head('bash-exit'))).includes('失败') && (await t.text(head('bash-exit'))).includes('1'));
  t.ok('默认紧凑行高', (await t.rect(head('bash-ok'))).h <= 28);
  t.ok('快照补得真实耗时', await t.waitFor(`${card('bash-ok')} [data-testid="task-notice-duration"]`));
  t.check('通知原本没有的耗时从快照补回（沿用整秒格式）', await t.text(`${card('bash-ok')} [data-testid="task-notice-duration"]`), '4s');
  await t.shot('tasks-collapsed');

  await open(t, 'bash-ok');
  t.ok('展开直接读取留存输出', await t.waitForText(body('bash-ok'), 'PASS 18 tests'));
  t.ok('未显示写给模型的工具API指令', !(await t.text(body('bash-ok'))).includes('job_output'));
  await t.click(head('bash-ok'), 20);
  t.check('再点收起，正文不留空块', await t.count(body('bash-ok')), 0);
  await open(t, 'bash-exit');
  t.ok('失败仍有具体输出', await t.waitForText(body('bash-exit'), 'Expected 1, received 2'));
  await t.shot('tasks-failure-expanded');
  await open(t, 'bash-missing');
  t.ok('已清理的记录如实说明输出缺口', await t.waitForText(body('bash-missing'), '任务记录已清理'));
  await open(t, 'bash-unresolved');
  t.ok('缺少开始时间不伪造耗时', await t.waitForText(body('bash-unresolved'), '没有任务开始时间'));
  await t.act('staleFrame');
  t.check('迟到运行中帧不让结算倒退', await t.js(`document.querySelector('${card('bash-stale')} [data-outcome]').dataset.outcome`), 'completed');

  await open(t, 'sa-abort');
  t.ok('完整报告与会话结算分开标明', (await t.text(head('sa-abort'))).includes('会话已中止'));
  t.ok('中止会话的完整回复仍然保留', await t.waitForText(body('sa-abort'), '审查工作已给出最终报告'));
  await open(t, 'sa-error');
  t.ok('子代理失败保留中间产出', await t.waitForText(body('sa-error'), '已产出的部分结果'));
  t.ok('失败原因与产出分开呈现', (await t.text(`${card('sa-error')} [data-testid="subagent-settled-diagnostic"]`)).includes('boom'));
  await open(t, 'sa-timeout');
  t.ok('超时原因含真实时间', (await t.text(`${card('sa-timeout')} [data-testid="subagent-settled-diagnostic"]`)).includes('30s'));
  await open(t, 'sa-done');
  t.ok('成功正文中的Diagnostic是正文而非失败诊断', await t.waitForText(`${card('sa-done')} [data-testid="subagent-settled-body"]`, 'this is quoted output'));
  t.check('成功正文不凭引用文案生成错误块', await t.count(`${card('sa-done')} [data-testid="subagent-settled-diagnostic"]`), 0);
  await open(t, 'sa-empty');
  t.ok('空结果仍有身份和状态，展开不留白', (await t.text(head('sa-empty'))).includes('sa-empty') && (await t.text(body('sa-empty'))).trim().length > 0);
  await open(t, 'sa-long');
  t.ok('长结果全文仍保留', await t.waitForText(`${card('sa-long')} [data-testid="subagent-settled-body"]`, '最后一行仍然保留'));
  const size = await t.js(`(() => { const e = document.querySelector('${card('sa-long')} [data-testid="subagent-settled-body"]'); return { visible: e.clientHeight, total: e.scrollHeight }; })()`);
  t.ok('长结果限高滚动，不截成摘要', size.visible <= 360 && size.total > size.visible * 2);
  await t.act('pushLive');
  await t.act('pushLive');
  t.ok('实时重复start/end只出现一个结算卡', await t.waitUntil(`document.querySelectorAll('${card('sa-live')}').length === 1`));

  await t.resize(360, 740);
  await t.js(`document.querySelector('#task-notices-scroll').scrollTop = 0`);
  t.ok('窄屏标题与元信息不撑破页面', await t.js('document.documentElement.scrollWidth <= innerWidth + 1'));
  await t.setTheme('light');
  await t.shot('tasks-light-narrow');
  t.check('没有组件渲染错误', await t.count('[data-testid="error-boundary-fallback"]'), 0);
}
