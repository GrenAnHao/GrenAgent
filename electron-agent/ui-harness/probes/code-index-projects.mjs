const home = '[aria-label="最近项目"]',
  cards = '[data-project-card]',
  scroll = '[data-project-scroll]';
const input = '[aria-label="搜索项目名称或路径"]',
  bulk = 'button[data-sync-stale]',
  back = '[aria-label="返回项目列表"]';
const card = (p) => '[data-project-card=' + JSON.stringify(p) + ']';
async function choose(t, path, label) {
  await t.click(card(path) + ' [aria-haspopup], ' + card(path) + ' button[aria-label$="的更多操作"]');
  const item = '.ant-dropdown:not(.ant-dropdown-hidden) [role="menuitem"]';
  await t.waitFor(item);
  await t.js(
    'document.querySelectorAll("[data-menu-choice]").forEach(n=>n.removeAttribute("data-menu-choice")); Array.from(document.querySelectorAll(' +
      JSON.stringify(item) +
      ')).find(n=>n.textContent.trim()===' +
      JSON.stringify(label) +
      ')?.setAttribute("data-menu-choice","1")',
  );
  await t.click('.ant-dropdown:not(.ant-dropdown-hidden) [data-menu-choice="1"]');
}
async function progress(t, path, text) {
  return t.waitForText(card(path) + ' [data-card-status]', text, 6500);
}
export default async function (t) {
  const { stale, long, empty, unknown, stale2, stale3, last, count } = await t.data();
  await t.waitForText('[aria-label="项目概览"]', '3 个待更新');
  t.check('所有项目都能在大厅浏览', await t.count(cards), count);
  t.check('大厅不重复显示选择器', await t.count('[aria-label="项目"]'), 0);
  t.ok('标题位于顶栏下面而非页面中央', (await t.rect(home + ' h3')).y - (await t.rect('header')).y < 110);
  t.ok(
    '同步时间优先使用各项目的落盘回执；未知时间不回退到检查、任务或未完成的文件行',
    (await progress(t, stale, '2天前 · 3 个文件待更新')) &&
      (await progress(t, long, '8天前')) &&
      (await progress(t, unknown, '无同步时间记录')),
  );
  t.ok(
    '未索引卡片用引导替代空统计',
    (await t.text(card(empty) + ' [data-project-metrics]')).includes('尚未建立代码图谱'),
  );
  t.ok(
    '首行卡片等高，标题、路径、统计、底栏逐行对齐',
    await t.js(`(()=>{
    const rows=[...document.querySelectorAll('[data-project-card]')].slice(0,3);
    return rows.every(c=>c.offsetHeight===rows[0].offsetHeight) && ['strong','[data-project-path]','[data-project-metrics]','[data-card-status]'].every(sel=>
      rows.every(c=>Math.abs(c.querySelector(sel).getBoundingClientRect().y-rows[0].querySelector(sel).getBoundingClientRect().y)<1))
  })()`),
  );
  t.ok(
    '长路径在卡片内单行省略',
    await t.js(
      `(()=>{const e=document.querySelector(${JSON.stringify(card(long) + ' [data-project-path]')});return e.scrollWidth>e.clientWidth&&getComputedStyle(e).textOverflow==='ellipsis'&&getComputedStyle(e).whiteSpace==='nowrap'})()`,
    ),
  );
  await t.shot('project-lobby');
  await t.hover(card(long) + ' [data-project-path]');
  t.ok('悬停可读完整路径', await t.waitForText('.ant-tooltip:not(.ant-tooltip-hidden)', long));
  await t.wheel(scroll, 980);
  t.ok(
    '长列表仅大厅滚动、可到达最后的项目',
    (await t.waitUntil(`document.querySelector('${scroll}').scrollTop>40`)) &&
      (await t.rect(card(last))).y < (await t.rect(scroll)).bottom,
  );
  await t.wheel(scroll, -1800);
  await t.waitUntil(`document.querySelector('${scroll}').scrollTop===0`);
  await t.click(input);
  await t.insertText('d:\\studio\\客户项目');
  t.ok(
    '按路径搜索兼容盘符大小写和反斜杠',
    (await t.waitUntil(`document.querySelectorAll('${cards}').length===1`)) && (await t.count(card(long))) === 1,
  );
  await t.key('a', ['control']);
  await t.key('Backspace');
  await t.click('[data-status-filter="未索引"]');
  t.check('状态筛选只列未索引项目', await t.count(cards), 1);
  await t.hover(card(empty));
  await t.click(card(empty) + ' [data-card-quick]');
  t.ok(
    '从未索引筛选原地开始，仍显示本卡真实进度',
    (await progress(t, empty, '1,240 / 2,600')) && (await t.count(home)) === 1,
  );
  await t.act('advance', empty);
  t.ok('轮询更新计数', await progress(t, empty, '2,345 / 2,600'));
  await t.shot('project-card-progress');
  await t.act('finish', empty);
  t.ok('完成后离开未索引筛选，保留清除入口', await t.waitForText(home, '没有匹配的项目', 6000));
  await t.click('[data-clear-filters]');
  t.ok('新索引卡显示落盘时间', await progress(t, empty, '同步于 刚刚'));
  await t.hover(card(stale));
  await t.click(card(stale) + ' [data-card-quick]');
  t.ok('单项目立即同步不跳入内页', (await progress(t, stale, '1,240 / 3,062')) && (await t.count(home)) === 1);
  await t.click(bulk);
  t.ok(
    '批量只提交另外两个待更新项目、不重复派发',
    (await progress(t, stale2, '418 / 912')) &&
      (await progress(t, stale3, '19 / 56')) &&
      (await t.waitForText('[aria-label="项目概览"]', '3 个同步中')) &&
      (await t.events()).filter((e) => e.startsWith('sync:')).length === 4,
  );
  await t.shot('project-batch-progress');
  await t.act('finish', stale);
  await t.act('finish', stale2);
  await t.act('finish', stale3);
  await progress(t, stale, '刚刚');
  await choose(t, long, '在资源管理器中打开目录');
  t.ok(
    '目录交给本机资源管理器，不打开项目页',
    (await t.events()).includes('open:' + long) && (await t.count(home)) === 1,
  );
  await choose(t, long, '立即重新索引');
  t.ok(
    '已索引项目明确派发全量重建',
    (await progress(t, long, '117 / 846')) && (await t.events()).includes('rebuild:' + long),
  );
  await t.act('finish', long);
  await progress(t, long, '刚刚');
  await choose(t, long, '从列表中移除项目');
  await t.act('remount');
  t.ok(
    '移除跨重新挂载生效并更新总数',
    (await t.waitForText('[aria-label="项目概览"]', '共 ' + (count - 1) + ' 个项目')) && !(await t.count(card(long))),
  );
  await t.act('pick', long);
  await t.click(home + ' .ant-btn-primary');
  t.ok(
    '重新添加可进入同一目录并恢复项目选择器',
    (await t.waitFor('[aria-label="项目"]')) && (await t.count(back)) === 1,
  );
  await t.click(back);
  t.ok(
    '返回列表恢复卡片，不重复重新索引',
    (await t.waitFor(card(long))) && (await t.events()).filter((e) => e === 'rebuild:' + long).length === 1,
  );
  await t.resize(640, 530);
  t.ok(
    '窄窗口没有横向溢出',
    await t.js(`document.querySelector('${scroll}').scrollWidth<=document.querySelector('${scroll}').clientWidth+1`),
  );
}
