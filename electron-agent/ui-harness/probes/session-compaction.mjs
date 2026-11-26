// Real Sidebar/MainChatColumn/ChatView; activity events use production reducer and session shadow switching.
const status = '[data-testid="compaction-indicator"]';
const done = '[data-testid="compaction-done"]';
const spinner = '[data-testid="compaction-spinner"]';
const seat = '[data-testid="composer-seat"]';
const activity = { operationId: 'manual-1', sessionId: 'layout-a', sessionPath: 'D:/sessions/layout-a.jsonl', source: 'manual',
  phase: 'preparing', startedAt: 1000, ownerEpoch: 'host-1', sequence: 1 };
export default async function (t) {
  t.ok('真实会话界面就绪', await t.waitFor('[data-testid="workbench-main"]'));
  const { sessionA, sessionB } = await t.data();
  await t.act('conversation');
  t.ok('上下文用量入口已绑定真实输入区', await t.waitFor('[aria-label="上下文用量"]'));
  await t.click('[aria-label="上下文用量"]');
  t.ok('压缩前展示真实统计 85%', await t.waitForText('body', '85% 已用'));
  await t.key('Escape');
  await t.act('compactionFixture', { type: 'compaction_activity', compaction: activity });
  t.ok('没有流式回复也可见压缩准备状态', await t.waitForText(status, '正在准备压缩上下文'));
  t.check('所属会话的侧栏运行标记可见', await t.countVisible('[data-testid="session-running"]'), 1);
  await t.act('compactionFixture', { type: 'compaction_start', compaction: { ...activity, phase: 'running', sequence: 2 } });
  t.ok('压缩持续显示运行中', await t.waitForText(status, '正在压缩上下文'));
  t.check('时间线只有一条运行分隔线，输入区不再重复显示', [
    await t.countVisible(`[data-testid="chat-scroll"] ${status}`),
    (await t.text(seat)).includes('正在压缩上下文'),
  ], [1, false]);
  t.check('运行分隔线不使用告警背景', (await t.style(status, ['background-color'])).backgroundColor, 'rgba(0, 0, 0, 0)');
  const motionPreference = (value) => t.win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: value ? [{ name: 'prefers-reduced-motion', value }] : [],
  });
  await motionPreference('no-preference');
  const rotation = await t.js(`document.querySelector('${spinner}')?.getAnimations().some(animation => animation.playState === 'running')`);
  t.check('运行图标实际播放旋转动画', rotation, true);
  await motionPreference('reduce');
  t.check('减少动态效果时图标保持静止', (await t.style(spinner, ['animation-name']))?.animationName, 'none');
  await motionPreference(null);
  await t.shot('compaction-single-divider');
  await t.act('compactionFixture', { type: 'agent_end', messages: [] });
  t.check('普通回合结束不能提前清除压缩', await t.countVisible(status), 1);
  await t.act('switchFixtureSession', sessionB);
  t.check('另一会话不继承压缩标记', await t.countVisible(status), 0);
  await t.act('switchFixtureSession', sessionA);
  t.ok('切回原会话恢复仍存活的活动', await t.waitForText(status, '正在压缩上下文'));
  await t.act('compactionUnconfirmedFixture');
  t.ok('宿主暂不可读时在同一分隔线说明状态未知', await t.waitForText(status, '暂时无法确认压缩状态'));
  t.check('无法确认时不继续用转圈暗示正在运行', await t.count(spinner), 0);
  const pendingRow = await t.rect(status);
  await t.act('compactUsageFixture', 120);
  await t.act('compactionFixture', { type: 'compaction_end', aborted: false, compaction: { ...activity, phase: 'finished', sequence: 3 }, contextRevision: 1 });
  t.check('真实终态收掉压缩状态', await t.countVisible(status), 0);
  t.ok('成功后留下同一个时间线位置的完成标记', await t.waitForText(done, '上下文已压缩'));
  const finishedRow = await t.rect(done);
  t.checkNear('完成标记与原分隔线纵向位置一致', finishedRow?.y, pendingRow?.y, 2);
  t.checkNear('完成标记不改变分隔线高度', finishedRow?.h, pendingRow?.h, 1);
  await t.click('[aria-label="上下文用量"]');
  t.ok('版本更新后展示宿主返回的实际 12% 而非猜测值', await t.waitForText('body', '12% 已用'));
  t.check('结束后侧栏不再点亮压缩', await t.countVisible('[data-testid="session-running"]'), 0);
  await t.js(`(() => {
    window.__handoffErrors = [];
    window.__handoffObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="composer-seat"]')?.textContent?.includes('Request was aborted')) window.__handoffErrors.push(performance.now());
    });
    window.__handoffObserver.observe(document.querySelector('[data-testid="composer-seat"]'), { subtree: true, childList: true, characterData: true });
    return true;
  })()`);
  const handoff = await t.sample(`document.querySelector('${status}')?.textContent ?? ''`, 600,
    () => t.act('compactionAutoHandoffFixture'));
  t.ok('跨帧先出现准备再进入压缩运行态', handoff.some(frame => frame.includes('正在准备')) && handoff.some(frame => frame.includes('正在压缩')));
  const flash = await t.js(`(() => { window.__handoffObserver.disconnect(); return window.__handoffErrors; })()`);
  t.check('真实帧和 DOM 变化全程没有内部 abort 红色错误闪现', flash, []);
  await t.act('compactionFixture', { type: 'compaction_end', aborted: true, errorMessage: '压缩服务失败',
    compaction: { ...activity, ownerEpoch: 'host-layout', operationId: 'policy-auto-1', phase: 'running', sequence: 6 } });
  t.ok('压缩本身失败仍显示真实错误', await t.waitForText(seat, '压缩服务失败'));
  t.check('压缩失败不追加完成标记', await t.countVisible(done), 1);
  const cancellation = { ...activity, ownerEpoch: 'host-layout', operationId: 'manual-cancel', sequence: 7 };
  await t.act('compactionFixture', { type: 'compaction_activity', compaction: cancellation });
  t.ok('独立压缩运行中仍可见停止控件', await t.waitFor('[data-testid="composer-stop"]'));
  await t.click('[data-testid="composer-stop"]');
  t.ok('停止只请求原会话的 abort', (await t.events()).includes(`agent-abort:${sessionA}`));
  t.check('请求停止尚无终态时不谎称压缩结束', await t.countVisible(status), 1);
  await t.act('compactionFixture', { type: 'compaction_end', aborted: true,
    compaction: { ...cancellation, phase: 'running', sequence: 8 } });
  t.check('SDK 取消终态后压缩状态收口', await t.countVisible(status), 0);

  // —— 前景切到 B 期间 A 在后台完成压缩：用量按会话与上下文版本刷新，旧请求不得回写 ——
  const usage = '[aria-label="上下文用量"]';
  const background = { ...activity, operationId: 'manual-bg' };
  await t.act('compactionFixture', { type: 'compaction_activity', compaction: { ...background, phase: 'preparing', sequence: 10 } });
  await t.act('compactionFixture', { type: 'compaction_start', compaction: { ...background, phase: 'running', sequence: 11 } });
  t.ok('切走前 A 仍在压缩', await t.waitForText(status, '正在压缩上下文'));
  await t.act('holdNextStats', sessionA);
  await t.act('switchFixtureSession', sessionB);
  await t.click(usage);
  t.ok('B 展示自己的 46% 用量', await t.waitForText('body', '46% 已用'));
  await t.key('Escape');
  await t.act('switchFixtureSession', sessionA);
  let held = false;
  for (let i = 0; i < 20 && !held; i += 1) {
    held = Boolean((await t.act('statsHoldState'))?.held);
    if (!held) await t.sleep(100);
  }
  t.ok('压缩前发出的 A 统计请求保持挂起', held);
  t.ok('切回 A 仍显示原压缩运行态', await t.waitForText(status, '正在压缩上下文'));
  t.check('切回不重置压缩开始时间', await t.act('compactionStartedAt'), 1000);
  await t.act('switchFixtureSession', sessionB);
  t.check('B 不继承 A 的压缩状态', await t.countVisible(status), 0);
  await t.click(usage);
  t.ok('A 后台完成前 B 仍显示自己的用量', await t.waitForText('body', '46% 已用'));
  await t.act('backgroundCompleteFixture', 2, 220);
  await t.sleep(250);
  t.ok('A 的后台完成不改写 B 的用量', ((await t.text('body')) ?? '').includes('46% 已用'));
  await t.key('Escape');
  await t.act('switchFixtureSession', sessionA);
  t.check('后台完成后回 A 不再显示压缩', await t.countVisible(status), 0);
  await t.click(usage);
  t.ok('回 A 取到压缩后的实际 22%', await t.waitForText('body', '22% 已用'));
  t.ok('统计请求携带 A 的新上下文版本', (await t.events()).includes(`stats:${sessionA}:2:220`));
  await t.act('releaseHeldStats');
  await t.sleep(500);
  const afterRelease = (await t.text('body')) ?? '';
  t.ok('迟到的压缩前统计不覆盖新用量', afterRelease.includes('22% 已用') && !afterRelease.includes('12% 已用') && !afterRelease.includes('46% 已用'));
  await t.key('Escape');

  // —— 真实 webContents.reload：renderer store 全部销毁，只从存活宿主快照恢复 ——
  const reloadActivity = { ...activity, operationId: 'manual-reload' };
  await t.act('compactionFixture', { type: 'compaction_activity', compaction: { ...reloadActivity, phase: 'preparing', sequence: 20 } });
  await t.act('compactionFixture', { type: 'compaction_start', compaction: { ...reloadActivity, phase: 'running', sequence: 21 } });
  t.ok('重载前压缩正在运行', await t.waitForText(status, '正在压缩上下文'));
  t.check('重载前记录宿主活动起点', await t.act('compactionStartedAt'), 1000);
  await t.act('preserveHostForReload');
  const loadDone = new Promise((resolve) => t.win.webContents.once('did-finish-load', resolve));
  t.win.webContents.reload();
  await loadDone;
  t.ok('重载后页面重新就绪', await t.waitUntil('window.__uiReady === true', 10000));
  t.ok('重载后真实会话界面恢复', await t.waitFor('[data-testid="workbench-main"]', 10000));
  t.ok('重载后从存活宿主快照恢复压缩状态', await t.waitForText(status, '正在压缩上下文', 10000));
  const reloadEvents = await t.events();
  t.check('恢复只读一次宿主运行清单', reloadEvents.filter(event => event === 'snapshot:host-after-reload').length, 1);
  t.check('重载后没有重放压缩开始事件', reloadEvents.filter(event => event.startsWith('fixture-event:compaction')).length, 0);
  t.check('重载后保留宿主记录的活动开始时间', await t.act('compactionStartedAt'), 1000);
  t.check('重载后侧栏仍标出原会话运行中', await t.countVisible('[data-testid="session-running"]'), 1);
  await t.shot('compaction-restored-after-reload');
  await t.click(usage);
  t.ok('重载后仍按 A 的上下文版本取用量', await t.waitForText('body', '22% 已用'));
  await t.act('compactUsageFixture', 180);
  await t.act('compactionFixture', { type: 'compaction_end', aborted: false,
    compaction: { ...reloadActivity, phase: 'running', sequence: 22 }, contextRevision: 3 });
  t.check('重载后终态仍能收口压缩状态', await t.countVisible(status), 0);
  t.ok('重载后终态刷新到实际 18%', await t.waitForText('body', '18% 已用'));
  await t.key('Escape');

  await t.setTheme('light');
  await t.shot('compaction-finished-light');
}
