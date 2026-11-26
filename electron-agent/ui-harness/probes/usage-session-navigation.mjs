export default async function (t) {
  const module = '[data-testid="module-usage"]';
  t.ok('初始打开不同于目标的会话', await t.waitForText('body','历史正文 / 原始会话'));
  for (const [id, title, workspace] of [['same','同项目历史','GrenAgent'], ['cross','跨项目历史','Second']]) {
    await t.clickReady(module);
    const row = '[data-usage-session="' + id + '"]';
    t.ok(title + '可打开',await t.waitFor(row + ' button'));
    const deleted = '[data-usage-session="deleted"]';
    t.check('已删除的账本记录不提供失效导航',await t.count(deleted + ' button'),0);
    await t.js(`document.querySelector('${row}').scrollIntoView({block:'center'})`);
    // Click a numeric cell, not the title button: the entire row should open the actual history.
    await t.clickReady(row + ' td:last-child');
    t.ok(title + '真实正文出现在主对话区',await t.waitUntil(`!document.querySelector('section[aria-label="用量统计"]') && document.body.innerText.includes('历史正文 / ${title}')`));
    t.ok('正文读取指向该项目和该会话', (await t.events()).includes('history:' + id + ':D:/usage-nav/' + workspace));
    if (id === 'same') await t.shot('usage-opened-history');
  }
}
