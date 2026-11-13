const q = id => `[data-testid="${id}"]`;
export default async function (t) {
  t.ok('真实设置页加载', await t.waitFor(q('settings-panel')));
  const budget = await t.count(q('set-cat-model-budgets'));
  const warming = await t.count(q('set-field-PI_CACHE_WARMING'));
  t.check('设置不显示模型压缩预算入口', budget, 0);
  t.check('设置不显示缓存预热开关', warming, 0);
  if (budget || warming) return;
  t.ok('原自动压缩触发值仍可见', await t.waitFor(q('set-field-AUTO_COMPACT_PERCENT')));
  const before = await t.act('saved');
  t.ok('打开设置不读取预算或预热专属配置', !(await t.events()).some(e => ['budget-read', 'warming-read'].includes(e)));
  await t.click(q('set-field-AUTO_TITLE'));
  await t.click(q('set-save'));
  t.ok('原一般设置仍可保存', await t.waitUntil(`(window.__uiEvents??[]).includes('settings-save')`));
  const after = await t.act('saved');
  if (before.budgets !== undefined) t.check('保存一般设置不改已存预算', after.budgets, before.budgets);
  if (before.mode !== undefined) t.check('保存一般设置不改SDK预热模式', after.mode, before.mode);
  t.ok('保存不触发预算或预热专属写入', !(await t.events()).some(e => /^(budget-save|budget-clear|sync-only|warming:)/.test(e)));
  await t.shot('settings-without-budget-warming-dark');
  await t.setTheme('light');
  await t.sleep(300);
  await t.shot('settings-without-budget-warming-light');
}
