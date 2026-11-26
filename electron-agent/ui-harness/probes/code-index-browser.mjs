import { checkPageHeading, compareThemeGeometry } from '../workbenchThemeChecks.mjs';

const home = '[aria-label="最近项目"]',
  cards = '[data-project-card]',
  state = '[data-testid="code-index-state"]';
const filter = 'input[aria-label="过滤项目"]',
  input = 'input[aria-label="搜索代码"]',
  entry = '[data-code-list] [data-code-entry]';
const overview = '[aria-label="项目索引概览"]',
  rank = '[data-ranked-file]',
  more = 'button[aria-label="代码索引更多操作"]';
const panel = '[data-testid="code-retrieval-panel"]';
const workbench = '[data-testid="code-index-workbench"]';

async function checkCodeIndexTheme(t) {
  const title = panel + ' h2';
  const field = `.ant-input-affix-wrapper:has(${input})`;
  const track = workbench + ' .ant-segmented';
  const selected = track + ' .ant-segmented-item-selected';
  const darkStyles = () => Promise.all(['main', title, workbench, field, track, selected].map(
    (selector) => t.style(selector, ['background-color', 'border-color', 'color', 'box-shadow'])));
  await t.hover(title);
  await t.sleep(200);
  const dark = await darkStyles();
  await checkPageHeading(t, '深色代码索引', title);
  await compareThemeGeometry(t, '代码索引', 'main', 'before');
  await t.shot('theme-code-index-dark');
  await t.setTheme('light');
  await compareThemeGeometry(t, '代码索引', 'main', 'after');
  await checkPageHeading(t, '浅色代码索引', title);
  t.checkColor('浅色代码索引画布', (await t.style('main', ['background-color']))?.backgroundColor, 'rgb(248, 249, 248)', 0);
  t.checkColor('浅色代码索引标题', (await t.style(title, ['color']))?.color, 'rgb(24, 24, 27)', 0);
  const card = await t.style(workbench, ['background-color', 'border-top-color', 'box-shadow']);
  t.checkColor('浅色代码索引白色卡片', card?.backgroundColor, 'rgb(255, 255, 255)', 0);
  t.checkColor('浅色代码索引卡片边框', card?.borderTopColor, 'rgba(0, 0, 0, 0.08)', 0);
  t.check('浅色代码索引外框保持深色的阴影', card?.boxShadow, dark[2]?.boxShadow);
  t.check('已索引标签保留成功语义', await t.js(`document.querySelector('${state}').dataset.tone`), 'success');
  t.check('代码索引搜索输入使用 13px', (await t.style(input,['font-size']))?.fontSize, '13px');
  t.checkColor('浅色代码索引选中模式凸起', (await t.style(selected, ['background-color']))?.backgroundColor, 'rgb(255, 255, 255)', 0);
  await t.shot('theme-code-index-light');
  await t.click(title);
  await t.key('/');
  t.ok('浅色代码索引搜索快捷键可聚焦', await t.js(`document.activeElement === document.querySelector('${input}')`));
  await t.sleep(200);
  const focus = await t.style(field, ['border-top-color', 'background-color', 'box-shadow']);
  t.checkColor('浅色代码索引搜索聚焦白底', focus?.backgroundColor, 'rgb(255, 255, 255)', 0);
  t.ok('聚焦有反馈', focus?.boxShadow !== 'none' || focus.borderTopColor !== card.borderTopColor);
  await t.click(title);
  await t.setTheme('dark');
  t.check('从浅色切回后代码索引深色表面与控件样式恢复', await darkStyles(), dark);
}

async function button(t, text, scope = 'document') {
  await t.js(
    `(() => {document.querySelector('[data-probe-press]')?.removeAttribute('data-probe-press'); const b=[...${scope}.querySelectorAll('button, .ant-dropdown-menu-item')].find(n=>n.textContent.trim()===${JSON.stringify(text)} && n.getBoundingClientRect().height>0); b?.setAttribute('data-probe-press','1');})()`,
  );
  await t.click('[data-probe-press="1"]');
}
async function menu(t, text) {
  await t.click(more);
  await t.waitFor('.ant-dropdown-menu');
  await button(t, text);
}
export default async function (t) {
  const { app, long, fresh } = await t.data();
  await t.waitForText(home, '已索引');
  await checkPageHeading(t, '最近项目', home+' h3');
  t.check('四个项目未选中便已实际检查', new Set((await t.events()).filter((e) => e.startsWith('status:'))).size, 4);
  t.check(
    '最近使用的项目排第一',
    await t.js(`document.querySelector('${cards}').getAttribute('data-project-card')`),
    app,
  );
  t.ok(
    '首屏显示完整路径、索引统计及时间',
    (await t.text(home)).includes('18,240') && (await t.text(home)).includes('同步于'),
  );
  await t.shot('recent-projects');
  t.check('大厅不显示项目选择器', await t.count('.ant-select'), 0);
  await t.click('[data-project-card="' + app + '"] button:first-child');
  await t.click('.ant-select');
  await t.waitFor(filter);
  t.check('下拉中无占位选项', await t.count('.ant-select-item-option'), 4);
  await t.click(filter);
  await t.type('studio');
  await t.waitUntil("document.querySelectorAll('.ant-select-item-option').length === 1");
  t.check('可按路径过滤出长项目名', await t.count('.ant-select-item-option'), 1);
  t.check(
    '状态胶囊不可压缩',
    (await t.style('.ant-select-item-option [data-index-badge]', ['flex-shrink'])).flexShrink,
    '0',
  );
  t.ok(
    '长项目名的状态完整位于选项内',
    await t.js(
      `(()=>{const r=document.querySelector('.ant-select-item-option').getBoundingClientRect(),b=document.querySelector('.ant-select-item-option [data-index-badge]');return b.textContent==='需更新'&&b.getBoundingClientRect().right<=r.right&&b.scrollWidth===b.clientWidth})()`,
    ),
  );
  await t.click('.ant-select-item-option');
  t.ok('选中后页头沿用相同需更新状态', await t.waitForText(state, '需更新'));
  await t.click('[aria-label="返回项目列表"]');
  await t.act('cancelPicker');
  await button(t, '添加本地项目', `document.querySelector('${home}')`);
  t.ok('取消目录选择后仍在最近项目', (await t.count(home)) === 1);
  await t.act('restorePicker');
  await button(t, '添加本地项目', `document.querySelector('${home}')`);
  t.ok(
    '新选本地目录只检查、不自动建索引',
    (await t.waitForText(state, '未索引')) && !(await t.events()).some((e) => e.startsWith('sync:')),
  );
  await t.click('[aria-label="返回项目列表"]');
  await t.click(`[data-project-card="${app}"]`);
  await t.waitFor(rank);
  await checkCodeIndexTheme(t);
  t.check(
    '核心文件按入度而非文件名排第一',
    await t.js(`document.querySelector('${rank}').getAttribute('data-ranked-file')`),
    'src/core/graph.ts',
  );
  t.ok('语言占比使用完整可见集合', (await t.text(overview)).includes('75%'));
  const top = (await t.rect(input)).y;
  await button(t, '同步索引');
  await t.waitForText('[data-index-progress]', '1,240 / 3,062 文件');
  t.check('手动同步不挤动搜索框', (await t.rect(input)).y, top);
  t.ok(
    '手动同步按钮原位加载且只能派发一次',
    (await t.count('[data-index-controls] .ant-btn-loading')) === 1 &&
      (await t.events()).filter((e) => e === 'sync:' + app).length === 1,
  );
  await t.act('advance');
  t.ok('进度自动推进', await t.waitForText('[data-index-progress]', '2,345 / 3,062 文件', 4000));
  await t.shot('sync-progress');
  await t.click('[aria-label="返回项目列表"]');
  t.ok('后台项目卡显示自己的实时进度', await t.waitForText(`[data-project-card="${app}"]`, '2,345 / 3,062 文件'));
  await t.click(`[data-project-card="${app}"]`);
  await t.act('finish');
  t.ok('完成后显示一次轻提示', await t.waitForText('.ant-message', '索引已同步', 5000));
  t.ok('回到统计与新的同步时间', await t.waitForText('[data-index-stats]', '同步于 刚刚'));
  t.check('同步结束位置也不变', (await t.rect(input)).y, top);
  await t.waitFor('[data-directory="src"]');
  t.check('目录树默认隐藏点目录', await t.count('[data-directory=".agents"]'), 0);
  await t.click('[data-directory="src"]');
  await t.click('[data-directory="src/core"]');
  t.ok('可逐级打开文件夹', await t.waitForText('[data-code-list]', 'src/core/graph.ts'));
  await t.click('[data-directory="src/core"]');
  t.ok('收起目录卸载其文件', !(await t.text('[data-code-list]')).includes('src/core/graph.ts'));
  await menu(t, '显示隐藏文件与生成产物');
  t.ok(
    '可按需显示隐藏目录和构建产物',
    (await t.waitFor('[data-directory=".agents"]')) && (await t.count('[data-directory="build"]')) === 1,
  );
  await menu(t, '隐藏非核心文件');
  await t.click('[aria-label="平铺列表"]');
  t.ok('平铺模式默认文件名排序', await t.waitForText(entry, 'app.ts'));
  await t.click('[aria-label="排序：文件名"]');
  t.ok(
    '可按引用文件数排序',
    (await t.waitForText(entry, '32 个文件引用')) && (await t.text(entry)).includes('graph.ts'),
  );
  await t.click(rank);
  t.ok(
    '排名直达源码和文件关系',
    (await t.waitFor('[aria-label="源码内容"]')) && (await t.waitForText('[aria-label="文件引用关系"]', 'src/app.ts')),
  );
  await t.click('button[aria-label="返回结果列表"]');
  await t.click('h2');
  await t.key('/');
  t.ok('/ 快捷聚焦', await t.js(`document.activeElement===document.querySelector('${input}')`));
  await t.type('core');
  await t.waitUntil(`document.querySelectorAll('${entry}').length===2`);
  await t.key('Down');
  await t.key('Down');
  t.ok(
    '方向键切换文件且输入框保留焦点',
    (await t.waitForText('[aria-label="代码详情"]', 'paths.ts')) &&
      (await t.js(`document.activeElement===document.querySelector('${input}')`)),
  );
  await t.key('Up');
  t.ok('上键切回上一个文件', await t.waitForText('[aria-label="代码详情"]', 'graph.ts'));
  await t.hover(entry);
  t.ok(
    '悬停可见复制和对话操作',
    await t.js(
      `getComputedStyle(document.querySelector('[data-code-list] [data-file-actions]')).visibility==='visible'`,
    ),
  );
  await t.click('[data-code-list] [aria-label="复制相对路径"]');
  t.ok('复制的是源项目相对路径', (await t.events()).includes('clipboard:src/core/graph.ts'));
  await t.click('[aria-label="代码详情"] [aria-label="添加到对话上下文"]');
  t.ok(
    '添加到当前对话使用源项目绝对路径，不发送',
    (await t.events()).includes('composer:' + app + '/src/core/graph.ts') && (await t.events()).includes('module:chat'),
  );
  await t.click('button[aria-label="返回结果列表"]');
  await t.resize(680, 760);
  await button(t, '项目概览');
  t.ok(
    '窄屏可单独查看概览',
    await t.js(
      `document.querySelector('${overview}').getBoundingClientRect().width>300 && document.documentElement.scrollWidth<=innerWidth`,
    ),
  );
  await t.setTheme('light');
  await t.shot('overview-light-narrow');
}
