const visibleOptions = `[...document.querySelectorAll('[role="option"]')].filter((el) => el.getClientRects().length > 0)`;

async function closePanel(t) {
  await t.key('Escape');
  await t.sleep(180);
}

async function modelPanel(t, side = 'left') {
  const trigger = `[data-testid="model-${side}"] [data-testid="model-trigger"]`;
  t.ok(`${side} 模型入口就绪`, await t.waitFor(trigger));
  await t.click(trigger, 20);
  t.ok('模型列表可见', await t.waitUntil(`Array.from(document.querySelectorAll('[data-model-id="reason"]')).some((el) => el.getClientRects().length > 0)`));
}

async function selectedLevel(t, side) {
  await modelPanel(t, side);
  const value = await t.js(`[...document.querySelectorAll('.ant-segmented-item-selected [data-level]')].find((el) => el.getClientRects().length > 0)?.getAttribute('data-level') ?? null`);
  await closePanel(t);
  return value;
}

async function pickLevel(t, value) {
  await modelPanel(t);
  await t.js(`document.querySelectorAll('[data-probe="target-level"]').forEach((el) => el.removeAttribute('data-probe'))`);
  await t.js(`(() => {
    const el = [...document.querySelectorAll('[data-level]')].find((node) => node.getClientRects().length > 0 && node.getAttribute('data-level') === ${JSON.stringify(value)});
    el?.setAttribute('data-probe', 'target-level');
  })()`);
  t.ok(`档位 ${value} 可选`, await t.waitFor('[data-probe="target-level"]'));
  await t.click('[data-probe="target-level"]', 12);
  await t.js(`document.querySelector('[data-probe="target-level"]')?.removeAttribute('data-probe')`);
  await closePanel(t);
}

// 弹层被 portal 到 body，不在各自的 pane 里；关掉的弹层内容仍留在 DOM。
// 所以先点开目标侧的 trigger，再取「可见且离该 trigger 最近」的开关，不能拿第一个匹配项。
const sideToggle = (side) => `(() => {
  const trigger = document.querySelector('[data-testid="model-${side}"] [data-testid="model-trigger"]');
  if (!trigger) return null;
  const tx = trigger.getBoundingClientRect().x;
  const visible = [...document.querySelectorAll('[data-testid="model-fast-toggle"]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ el, d: Math.abs(el.getBoundingClientRect().x - tx) }))
    .sort((left, right) => left.d - right.d);
  return visible[0]?.el ?? null;
})()`;
const visiblePressed = (side) => `(${sideToggle(side)})?.getAttribute('aria-pressed') ?? null`;

async function selectedFast(t, side) {
  await modelPanel(t, side);
  const value = await t.js(visiblePressed(side));
  await closePanel(t);
  return value;
}

async function toggleFast(t, side = 'left') {
  await modelPanel(t, side);
  await t.js(`document.querySelectorAll('[data-probe="fast-toggle"]').forEach((el) => el.removeAttribute('data-probe'))`);
  t.ok(`${side} Fast 开关可点`,
    await t.waitUntil(`(() => { const el = ${sideToggle(side)}; if (!el || el.disabled) return false; el.setAttribute('data-probe', 'fast-toggle'); return true; })()`));
  await t.click('[data-probe="fast-toggle"]', 12);
  const value = await t.js(`document.querySelector('[data-probe="fast-toggle"]')?.getAttribute('aria-pressed') ?? null`);
  await t.js(`document.querySelectorAll('[data-probe="fast-toggle"]').forEach((el) => el.removeAttribute('data-probe'))`);
  await closePanel(t);
  return value;
}

async function pickModel(t, id) {
  await modelPanel(t);
  await t.click(`[data-model-id="${id}"][data-provider="relay"]`, 20);
  await closePanel(t);
}

async function pickSelect(t, kind, label) {
  await t.js(`document.querySelectorAll('[data-probe="target-select"]').forEach((el) => el.removeAttribute('data-probe'))`);
  await t.click(`[data-testid="${kind}-left"] [role="combobox"]`, 12);
  t.ok(`${kind} 选项 ${label} 在下拉中`, await t.waitUntil(`${visibleOptions}.some((el) => el.textContent.trim().startsWith(${JSON.stringify(label)}))`));
  await t.js(`(() => {
    const el = ${visibleOptions}.find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}));
    el?.setAttribute('data-probe', 'target-select');
  })()`);
  await t.click('[data-probe="target-select"]', 20);
  await t.js(`document.querySelectorAll('[data-probe="target-select"]').forEach((el) => el.removeAttribute('data-probe'))`);
  await t.sleep(180);
}

async function choose(t, id) {
  await closePanel(t);
  await t.click(`[data-testid="${id}"]`, 12);
  await t.sleep(180);
}

async function waitPreference(t, path, field, value) {
  return t.waitUntil(`JSON.parse(localStorage.getItem('session-preferences-fixture-host') || '{}').sessions?.[${JSON.stringify(path)}]?.[${JSON.stringify(field)}] === ${JSON.stringify(value)}`);
}

export default async function (t) {
  const { a, b } = await t.data();
  t.ok('A 显示自己的 Agent 模式', await t.waitForText('[data-testid="mode-left"]', 'Agent'));
  t.ok('同时打开的 B 显示自己的 Ultra 模式', await t.waitForText('[data-testid="mode-right"]', 'Ultra'));
  t.check('A 独立恢复 high', await selectedLevel(t, 'left'), 'high');
  t.check('B 同模型独立恢复 low', await selectedLevel(t, 'right'), 'low');

  // Fast 是第五项会话偏好：同项目、同供应商、同模型 A 开 / B 关。
  t.check('A 同模型 Fast 开启', await selectedFast(t, 'left'), 'true');
  t.check('B 同模型 Fast 关闭', await selectedFast(t, 'right'), 'false');
  t.check('A 外侧快速可见', await t.count('[data-testid="model-left"] [data-testid="model-trigger-fast"]'), 1);
  t.check('B 外侧不显示快速', await t.count('[data-testid="model-right"] [data-testid="model-trigger-fast"]'), 0);
  t.check('关闭 A 的 Fast', await toggleFast(t), 'false');
  t.ok('A Fast 关闭写回 A 的第五字段', await waitPreference(t, a, 'fastMode', false));
  t.check('关闭 A 没改 B 的 Fast', (await t.act('disk')).sessions[b].fastMode, false);
  t.check('A Fast 开关没有动 A 的思考档', (await t.act('disk')).sessions[a].thinkingLevel, 'high');
  t.check('A Fast 开关没有动 B 的思考档', (await t.act('disk')).sessions[b].thinkingLevel, 'low');
  t.check('A Fast 没有反写项目默认', (await t.act('disk')).defaults.fastMode, undefined);
  t.check('重新打开 A 的 Fast', await toggleFast(t), 'true');
  t.ok('A Fast 重新开启写回 A', await waitPreference(t, a, 'fastMode', true));
  t.check('A 外侧快速恢复', await t.count('[data-testid="model-left"] [data-testid="model-trigger-fast"]'), 1);
  await choose(t, 'choose-b');
  t.check('切到 B 不继承 A 的 Fast', await selectedFast(t, 'left'), 'false');
  t.check('打开 B 的 Fast', await toggleFast(t), 'true');
  t.ok('B Fast 开启写回 B', await waitPreference(t, b, 'fastMode', true));
  t.check('另一个 B 视图同步 Fast 状态', await t.count('[data-testid="model-right"] [data-testid="model-trigger-fast"]'), 1);
  await choose(t, 'choose-a');
  t.check('回到 A 仍是开启', await selectedFast(t, 'left'), 'true');

  await pickLevel(t, 'medium');
  t.ok('A 修改为 medium 写回 A', await waitPreference(t, a, 'thinkingLevel', 'medium'));
  t.check('A 改档没有改 B', (await t.act('disk')).sessions[b].thinkingLevel, 'low');
  await choose(t, 'choose-b');
  t.check('同项目切到 B 恢复 low', await selectedLevel(t, 'left'), 'low');
  await pickLevel(t, 'high');
  t.ok('B 修改为 high 写回 B', await waitPreference(t, b, 'thinkingLevel', 'high'));
  t.check('另一个 B 视图同步同会话值', await selectedLevel(t, 'right'), 'high');
  await choose(t, 'choose-a');
  t.check('切回 A 仍为 medium', await selectedLevel(t, 'left'), 'medium');

  await t.js(`(() => {
    const root = document.querySelector('[data-testid="context-left"]');
    const label = [...(root?.querySelectorAll('*') ?? [])].find((el) => el.textContent.trim().startsWith('已收集上下文') && ![...el.children].some((child) => child.textContent.trim().startsWith('已收集上下文')));
    (label?.closest('button, [role="button"], [aria-expanded]') ?? label)?.setAttribute('data-probe', 'context-header');
  })()`);
  t.ok('上下文组标题可点击', await t.waitFor('[data-probe="context-header"]'));
  await t.click('[data-probe="context-header"]', 20);
  await t.sleep(180);
  t.check('A 的上下文展开状态已保存', await t.act('expanded', a), true);
  await t.click('[data-testid="context-left"] [data-testid="tool-execution"]', 24);
  t.check('工具卡函数式展开写入布尔状态', await t.act('toolExpanded', a), true);
  t.check('同工具 ID 的 B 仍保持收起', await t.act('expanded', b), false);
  t.check('B 工具详情没有带入 A 的状态', await t.act('toolExpanded', b), false);
  await choose(t, 'choose-b');
  t.check('进入 B 不带 A 的展开状态', await t.countVisible('[data-testid="context-left"] [data-testid="tool-execution"]'), 0);
  await choose(t, 'choose-a');
  t.ok('回到 A 恢复展开的工具行', await t.waitFor('[data-testid="context-left"] [data-testid="tool-execution"]'));

  await pickSelect(t, 'mode', 'Ask');
  t.ok('Ask 保存在 A', await waitPreference(t, a, 'mode', 'ask'));
  t.ok('Ask 临时禁用审批控件', await t.js(`(() => { const el = document.querySelector('[data-testid="approval-left"] [role="combobox"]'); return Boolean(el && (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'))); })()`));
  t.ok('Ask 仍显示保存的请求批准', (await t.text('[data-testid="approval-left"]')).includes('请求批准'));
  t.check('Ask 没有重写审批偏好', (await t.act('disk')).sessions[a].approval, 'ask');
  await pickSelect(t, 'mode', 'Agent');
  await pickSelect(t, 'approval', '替我审批');
  t.ok('A 审批独立修改', await waitPreference(t, a, 'approval', 'auto'));
  t.check('B 审批没有被 A 覆盖', (await t.act('disk')).sessions[b].approval, 'workspace');

  await pickModel(t, 'plain');
  t.ok('A 改为非推理模型', await t.waitForText('[data-testid="model-left"]', 'Plain'));
  await modelPanel(t);
  t.check('换成无 Fast 能力的模型：控件隐藏', await t.count('[data-testid="model-fast-toggle"]'), 0);
  t.check('换成无 Fast 能力的模型：外侧不显示快速', await t.count('[data-testid="model-left"] [data-testid="model-trigger-fast"]'), 0);
  await closePanel(t);
  t.check('能力撤销保留会话 Fast 保存值', (await t.act('disk')).sessions[a].fastMode, true);
  t.check('换非推理模型保留思考保存值', (await t.act('disk')).sessions[a].thinkingLevel, 'medium');
  await modelPanel(t);
  t.ok('非推理模型说明保存档与当前生效档', await t.waitFor('[data-testid="thinking-effective-hint"]'));
  const effectiveHint = await t.text('[data-testid="thinking-effective-hint"]');
  t.ok('说明包含原中档和当前关闭', effectiveHint.includes('中') && effectiveHint.includes('关闭'));
  await closePanel(t);
  await pickModel(t, 'reason');
  t.check('切回推理模型恢复 medium', await selectedLevel(t, 'left'), 'medium');
  t.check('切回支持 Fast 的模型恢复 A 的开启', await selectedFast(t, 'left'), 'true');
  t.check('切回支持 Fast 的模型恢复外侧快速', await t.count('[data-testid="model-left"] [data-testid="model-trigger-fast"]'), 1);
  t.check('普通会话修改没有反写默认模型', (await t.act('disk')).defaults.model.id, 'reason');
  t.check('普通模式修改没有反写项目默认', (await t.act('disk')).defaults.mode, 'agent');
  t.check('普通档位修改没有反写项目默认', (await t.act('disk')).defaults.thinkingLevel, 'medium');

  await t.act('beginPlan');
  t.ok('会话已有计划时显示 Plan', await t.waitForText('[data-testid="mode-left"]', 'Plan'));
  await pickSelect(t, 'mode', 'Ultra');
  t.ok('未确认计划拒绝手切 Ultra，界面恢复 Plan', await t.waitForText('[data-testid="mode-left"]', 'Plan'));
  t.check('被拒的模式更改没有持久化', (await t.act('disk')).sessions[a].mode, 'plan');
  t.check('被拒的模式更改没有动思考偏好', (await t.act('disk')).sessions[a].thinkingLevel, 'medium');
  await t.act('clearPlan');
  await pickSelect(t, 'mode', 'Debug');
  await modelPanel(t);
  t.ok('有显式的设为项目默认入口', await t.waitFor('[data-testid="save-project-defaults"]'));
  await t.click('[data-testid="save-project-defaults"]', 20);
  t.ok('显式默认保存成功', await t.waitUntil(`(window.__uiEvents ?? []).includes('save-defaults')`));
  await closePanel(t);
  t.check('显式入口保存当前模式为默认', (await t.act('disk')).defaults.mode, 'debug');
  t.check('保存默认仍不追改 B', (await t.act('disk')).sessions[b].mode, 'ultra');

  await choose(t, 'new-draft');
  t.ok('新草稿继承显式项目默认 Debug', await t.waitForText('[data-testid="mode-left"]', 'Debug'));
  // 「设为项目默认」时 Fast 是开着的：显式默认可以带 Fast，新草稿按默认走。
  t.check('显式项目默认把当时的 Fast 一起保存', (await t.act('disk')).defaults.fastMode, true);
  t.check('新草稿继承显式项目默认的 Fast 开启', await selectedFast(t, 'left'), 'true');
  t.check('草稿里关闭 Fast', await toggleFast(t), 'false');
  t.check('草稿 Fast 点选没有写任何会话', (await t.act('disk')).sessions[a].fastMode, true);
  t.check('草稿 Fast 点选没有改 B', (await t.act('disk')).sessions[b].fastMode, true);
  t.check('草稿 Fast 点选没有改项目默认', (await t.act('disk')).defaults.fastMode, true);
  await pickLevel(t, 'high');
  await choose(t, 'new-draft');
  t.check('另一份新草稿不继承前一份 high', await selectedLevel(t, 'left'), 'medium');
  t.check('另一份新草稿仍按默认开着 Fast，不受前一份关闭影响', await selectedFast(t, 'left'), 'true');
  await choose(t, 'draft-0');
  t.check('回到第一份草稿保留自己的 high', await selectedLevel(t, 'left'), 'high');
  t.check('回到第一份草稿保留自己的 Fast 关闭', await selectedFast(t, 'left'), 'false');
  t.check('草稿点选没有改 B', (await t.act('disk')).sessions[b].thinkingLevel, 'high');
  t.check('草稿点选没有改变项目默认', (await t.act('disk')).defaults.thinkingLevel, 'medium');

  await choose(t, 'choose-a');
  await t.act('remount');
  t.ok('重挂载后从会话记录恢复 A 的 Debug', await t.waitForText('[data-testid="mode-left"]', 'Debug'));
  t.check('重挂载恢复 A medium', await selectedLevel(t, 'left'), 'medium');
  t.check('重挂载恢复 B high', await selectedLevel(t, 'right'), 'high');
  t.check('重挂载恢复 A 的 Fast 开启', await selectedFast(t, 'left'), 'true');
  t.check('重挂载恢复 B 的 Fast 开启', await selectedFast(t, 'right'), 'true');
  t.check('重挂载恢复 A 展开状态', await t.act('expanded', a), true);
  await t.shot('restored');
  await new Promise((resolve) => {
    t.win.webContents.once('did-finish-load', resolve);
    t.win.webContents.reload();
  });
  t.ok('页面重载后 A 从宿主记录恢复 Debug', await t.waitForText('[data-testid="mode-left"]', 'Debug'));
  t.check('页面重载恢复 A medium', await selectedLevel(t, 'left'), 'medium');
  t.check('页面重载恢复 A 的 Fast 开启', await selectedFast(t, 'left'), 'true');
  t.check('页面重载恢复 B 的 Fast 开启', await selectedFast(t, 'right'), 'true');
  t.check('页面重载恢复 A 上下文展开', await t.act('expanded', a), true);
  t.check('页面重载恢复 A 工具详情展开', await t.act('toolExpanded', a), true);
  t.check('页面重载后 B 仍然没有 A 的展开状态', await t.act('expanded', b), false);
  await t.setTheme('light');
  t.ok('浅色下 A 的选择仍可读', await t.waitForText('[data-testid="model-left"]', 'Reasoning'));
  await t.shot('light');
}
