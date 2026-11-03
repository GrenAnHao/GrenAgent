export default async function (t) {
  const summary = '[data-testid="task-native-wiki-summary"]';
  t.ok('任务详情显示 native 摘要', await t.waitFor(summary));
  const text = await t.text(summary);
  for (const expected of ['qoder-wiki-local-v1', 'operation-1', '部分覆盖', '9 篇', '10 篇', '2 项', '投影失败']) t.ok(`展示 ${expected}`, text.includes(expected));
  t.ok('完成状态与部分覆盖同时显示', (await t.text('.ant-drawer-body')).includes('已完成') && text.includes('部分覆盖'));
  await t.js(`document.querySelector('${summary}')?.scrollIntoView({ block: 'center' })`);
  await t.shot('native-task-summary-dark');
  await t.setTheme('light');
  t.ok('浅色主题仍显示失败项和投影状态', (await t.text(summary)).includes('投影失败'));
  await t.shot('native-task-summary-light');
}
