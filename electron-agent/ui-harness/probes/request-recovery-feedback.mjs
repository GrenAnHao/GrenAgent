// Real Sidebar/MainChatColumn/ChatView with Pi events reduced by production applyEvent.
const retry = '[data-testid="composer-seat"]';
const event = (type, extra = {}) => ({ type, ...extra });
const push = (t, ev) => t.act('recoveryFixture', ev);
const identity = (attempt) => ({ runId: 1, attempt });
const content = (type, delta, attempt = 1) => event('message_update', {
  responseAttempt: identity(attempt),
  assistantMessageEvent: { type, delta, contentIndex: 0 },
});
const visible = async (t, text) => (await t.text(retry)).includes(text);

export default async function (t) {
  t.ok('真实对话界面就绪', await t.waitFor('[data-testid="workbench-main"]'));
  await t.setTheme('dark');
  await push(t, event('agent_start', { responseAttempt: identity(0) }));
  await push(t, event('auto_retry_start', { attempt: 1, maxAttempts: 3, errorMessage: '初次请求超时', responseAttempt: identity(1) }));
  t.ok('重试开始但尚未输出时保留旧原因', await visible(t, '初次请求超时'));
  await push(t, event('message_start', { message: { role: 'assistant', content: [] }, responseAttempt: identity(1) }));
  t.ok('空消息不是恢复证据', await visible(t, '初次请求超时'));
  await push(t, content('text_delta', '正在输出正文'));
  t.ok('首个正文增量立即撤旧异常', !(await visible(t, '初次请求超时')));
  await push(t, event('auto_retry_start', { attempt: 2, maxAttempts: 3, errorMessage: '本次请求失败', responseAttempt: identity(2) }));
  t.ok('再次失败显示本次错误', await visible(t, '本次请求失败'));
  await push(t, content('text_delta', '旧尝试迟到', 1));
  t.ok('旧尝试迟到不清当前错误', await visible(t, '本次请求失败'));
  await push(t, content('thinking_delta', '现在恢复了', 2));
  t.ok('当前思考增量立即撤旧异常', !(await visible(t, '本次请求失败')));
  await push(t, event('auto_retry_start', { attempt: 3, maxAttempts: 3, errorMessage: '又一次失败', responseAttempt: identity(3) }));
  await push(t, content('toolcall_delta', '{"', 3));
  t.ok('工具调用参数增量也能清除提示', !(await visible(t, '又一次失败')));
  await push(t, event('auto_retry_start', { attempt: 4, maxAttempts: 4, errorMessage: '终止前的旧错误', responseAttempt: identity(4) }));
  await push(t, content('text_delta', '恢复后仍在执行', 4));
  t.ok('恢复后旧浮层消失但真实停止按钮仍在', await t.waitFor('[data-testid="composer-stop"]'));
  await t.click('[data-testid="composer-stop"]');
  t.ok('恢复后取消仍发原会话后端 abort', (await t.events()).includes('agent-abort:D:/sessions/layout-a.jsonl'));
  t.check('用户取消后执行控件收口', await t.countVisible('[data-testid="composer-stop"]'), 0);
  await t.setTheme('light');
  await t.shot('recovered-light');
}
