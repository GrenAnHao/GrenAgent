const RECEIVED = '[data-testid="agent-message-pill"]';
const SENT = '[data-testid="send-message-card"]';
const BODY = '[data-testid="agent-message-body"]';

export default async function (t) {
  t.ok('历史代理消息立即显示正文', await t.waitForText(RECEIVED, '.env.local'));
  const incoming = (await t.texts(RECEIVED))[0];
  t.ok('接收方和发送方均有身份', incoming.includes('sa-1') && incoming.includes('parent-1'));
  t.ok('接收状态是未唤醒', incoming.includes('未唤醒'));
  t.ok('收到的正文按 Markdown 渲染', await t.waitFor(`${RECEIVED} code`));
  t.ok('发送的正文无需点击即可读', await t.waitForText(SENT, '保留全部失败原因'));
  const sent = await t.text(SENT);
  t.ok('发送卡写明双方和实际投递状态', sent.includes('parent-1') && sent.includes('sa-2') && sent.includes('已送达') && sent.includes('未唤醒'));
  t.check('发送消息提供折叠按钮', await t.count(`${SENT} [data-testid="agent-message-toggle"]`), 1);
  await t.click(`${SENT} [data-testid="agent-message-toggle"]`, 20);
  t.check('收起后保留双方和投递状态，正文不外铺', await t.count(`${SENT} ${BODY}`), 0);
  t.ok('折叠头仍能辨认发送与接收方', (await t.text(SENT)).includes('sa-2') && (await t.text(SENT)).includes('已送达'));
  await t.shot('communication-collapsed');
  await t.click(`${SENT} [data-testid="agent-message-toggle"]`, 20);
  t.ok('再次展开恢复完整正文', await t.waitForText(SENT, '保留全部失败原因'));
  t.ok('唤醒型历史消息按代理通信展示', (await t.texts(RECEIVED)).some((text) => text.includes('中间进展')));
  t.ok('发送卡仍处在前后正文之间', await t.js(`(() => {
    const nodes = [...document.querySelectorAll('#timeline > div')];
    const text = nodes.map(n => n.textContent).join('|');
    return text.indexOf('发送前的判断') < text.indexOf('保留全部失败原因') && text.indexOf('保留全部失败原因') < text.indexOf('发送后的下一步');
  })()`));
  t.ok('普通注入保持原样', (await t.text('[data-testid="notice-pill"]')).includes('已注入上下文'));
  await t.shot('communication-default');

  await t.act('pushLive', 3000);
  t.ok('实时静默通信正文直接可见', await t.waitUntil(`[...document.querySelectorAll('${RECEIVED}')].some(e => e.textContent.includes('date.ts'))`));
  t.check('start/end 只产生一张接收卡', await t.count(RECEIVED), 3);
  await t.act('pushLive', 3001);
  t.check('正文相同的独立消息保留两条', await t.count(RECEIVED), 4);
  await t.act('pushWaking');
  t.ok('唤醒型实时消息不会等到刷新才出现', await t.waitUntil(`[...document.querySelectorAll('${RECEIVED}')].some(e => e.textContent.includes('实时唤醒消息正文'))`));
  t.check('实时唤醒消息 start/end 不重复', await t.count(RECEIVED), 5);

  await t.act('showLong');
  t.ok('超长消息首段立即显示', await t.waitForText(RECEIVED, '第 1 段'));
  const size = await t.js(`(() => { const e = document.querySelector('${BODY}'); return { height: e.clientHeight, total: e.scrollHeight }; })()`);
  t.ok('长正文限高且全文仍在滚动区', size.height <= 320 && size.total > size.height * 2);
  t.ok('末段没有被截断', (await t.text(BODY)).includes('完整消息的最后一段'));
  await t.wheel(BODY, 20000);
  t.ok('用户能滚动读取末段', await t.waitUntil(`document.querySelector('${BODY}').scrollTop > 200`));
  await t.resize(360, 700);
  t.ok('窄屏长单词不撑破页面', await t.js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await t.shot('communication-long-narrow');

  await t.act('showEmpty');
  t.ok('空正文保留身份并明确缺口', await t.waitForText(RECEIVED, '未包含消息正文'));
  t.check('空正文不生成空白 Markdown 容器', await t.count(BODY), 0);
  await t.resize(1420, 880);
  await t.act('showChild');
  t.ok('真实子代理详情显示发送正文', await t.waitForText(SENT, '子代理给父代理的完整报告'));
  const childSent = await t.text(SENT);
  t.ok('子代理发送方使用自身身份而非父会话身份', childSent.includes('sa-child') && childSent.includes('parent-1') && childSent.indexOf('sa-child') < childSent.indexOf('parent-1'));
  t.ok('父代理给子代理的接收正文默认可读', await t.waitForText(RECEIVED, '父代理回复子代理的完整指令'));
  const childReceived = await t.text(RECEIVED);
  t.ok('子代理接收方也使用自身身份', childReceived.indexOf('parent-1') < childReceived.indexOf('sa-child'));
  t.ok('子代理实际中间与最终输出均呈现在对话中', (await t.text('#timeline')).includes('子代理的中间输出') && (await t.text('#timeline')).includes('子代理的最终输出'));
  await t.shot('communication-child-transcript');
  await t.act('showCodemode');
  t.ok('超过六条调用也不会藏起通信卡', await t.waitForText(SENT, '嵌套历史消息完整可见'));
  t.check('完整与截短历史两张通信卡均展示', await t.count(SENT), 2);
  t.ok('上游参数预览的限制写明', (await t.text(SENT)).includes('正文可能不完整'));
  t.ok('截短记录保留已有正文', (await t.texts(SENT))[1].includes('上游截短的内容'));
  await t.shot('communication-codemode-history');

  await t.setTheme('light');
  t.check('浅色主题通信卡保持可见', await t.countVisible(SENT), 2);
  t.ok('没有渲染错误兜底', await t.count('[data-testid="error-boundary-fallback"]') === 0);
  await t.shot('communication-light');
}
