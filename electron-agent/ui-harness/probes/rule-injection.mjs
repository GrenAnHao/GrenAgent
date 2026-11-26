const CARD = '[data-testid="rule-injection-pill"]';

export default async function (t) {
  const first = `${CARD} button`;
  await t.waitFor(first);
  t.check('历史显示一个明确的规则提示', await t.count(CARD), 1);
  t.ok('摘要显示规则数量', (await t.text(first)).includes('已注入规则 · 2 条'));
  t.check('默认收起，不显示来源列表', await t.count(`${CARD} li`), 0);

  await t.key('Tab');
  t.ok('键盘可聚焦提示按钮', await t.js(`document.activeElement === document.querySelector('${first}')`));
  await t.key('Space');
  await t.waitFor(`${CARD} li`);
  t.check('展开显示全局和项目规则', await t.texts(`${CARD} li`), ['全局输出用中文language.md', '项目沿用项目代码风格code-style.md']);
  await t.shot('dark-expanded');
  await t.click(first);
  t.check('点击可收起', await t.count(`${CARD} li`), 0);

  await t.act('live');
  await t.waitUntil(`document.querySelectorAll('${CARD}').length === 2`);
  t.check('相同规则的新回合可见；重放帧与空规则不生成额外卡片', await t.count(CARD), 2);
  await t.act('reload');
  t.check('历史快照与实时重叠时依旧每轮只出现一次', await t.count(CARD), 2);

  await t.setTheme('light');
  await t.resize(480, 640);
  await t.click(first);
  await t.waitFor(`${CARD} li`);
  t.check('窄窗浅色主题可展开', await t.countVisible(`${CARD} li`), 2);
  await t.shot('light-narrow');
}
