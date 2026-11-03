/**
 * Fast 是第五项会话偏好，同时保留原有控件覆盖。
 *
 * 身份走 App 主界面同样的来源：场景只改 useSessionStore.activeSessionPath（全局当前会话），
 * probe 不传任何显式 scope。
 */
const trigger = '[data-testid="model-trigger"]';
const toggle = '[data-testid="model-fast-toggle"]';
const triggerFast = '[data-testid="model-trigger-fast"]';
const row = (provider, id) => `[data-provider="${provider}"][data-model-id="${id}"]`;
const pressed = `document.querySelector('${toggle}')?.getAttribute('aria-pressed')`;

async function select(t, provider, id) {
  const selector = row(provider, id);
  await t.js(`document.querySelector('${selector}').scrollIntoView({block:'nearest'})`);
  await t.click(selector, 24);
  await t.waitUntil(`(window.__uiEvents ?? []).includes('model:${provider}/${id}')`);
}

async function openPanel(t) {
  t.ok('模型入口就绪', await t.waitFor(trigger));
  await t.click(trigger, 20);
}

async function openPanelWithToggle(t) {
  await openPanel(t);
  t.ok('Fast 开关可见', await t.waitFor(toggle));
}

async function closePanel(t) {
  await t.key('Escape');
  await t.sleep(180);
}

async function choose(t, id) {
  await closePanel(t);
  await t.click(`[data-testid="${id}"]`, 12);
  await t.sleep(220);
}

export default async function (t) {
  const { a, b } = await t.data();
  const storedFor = (path) => `JSON.parse(localStorage.getItem('model-fast-fixture-host') || '{}').sessions?.[${JSON.stringify(path)}]?.fastMode`;

  // ——— 原有覆盖：能力图标矩阵与布局 ———
  t.ok('模型选择器就绪', await t.waitFor(trigger));
  t.check('供应商配置中文名称为快速', (await t.text('label:has(input[data-testid="prov-model-fast-0"])')).trim(), '快速');
  await t.click(trigger, 20);
  t.ok('档位可见', await t.waitFor('[data-testid="model-level-row"]'));
  t.check('未勾选 Fast：没有闪电开关', await t.count(toggle), 0);
  const before = await t.rect('[data-testid="model-level-row"] .ant-segmented');
  await t.shot('before');
  await t.click(trigger, 20);
  await t.click('label:has(input[data-testid="prov-model-fast-0"])', 8);
  await t.click('label:has(input[data-testid="prov-model-fast-1"])', 8);
  await t.click('[data-testid="fast-save"]', 8);
  await t.click(trigger, 20);
  t.ok('勾选后显示 Fast 开关', await t.waitFor(toggle));
  t.ok('Fast 初始值来自当前会话（A 为开）', await t.waitUntil(`${pressed} === 'true' && !document.querySelector('${toggle}').disabled`));
  const seg = await t.rect('[data-testid="model-level-row"] .ant-segmented');
  const bolt = await t.rect(toggle);
  t.ok('闪电紧贴档位右侧，同一行', bolt.x >= seg.x + seg.w && bolt.x - seg.x - seg.w < 10 && Math.abs(bolt.y - seg.y) <= 3);
  t.ok('增加 Fast 后档位仍有可用宽度', seg.w > 150 && seg.w < before.w);

  const expected = [[], ['fast'], ['reasoning'], ['reasoning', 'fast'], ['image'], ['image', 'fast'], ['image', 'reasoning'], ['image', 'reasoning', 'fast']];
  for (const provider of ['claude', 'openai']) {
    for (let i = 0; i < 8; i++) {
      const id = i.toString(2).padStart(3, '0');
      t.check(`${provider} ${id} 能力顺序及组合`, await t.js(`[...document.querySelectorAll('${row(provider, id)} [data-capability]')].map(el=>el.dataset.capability)`), expected[i]);
    }
  }
  for (const provider of ['claude', 'openai']) {
    const shortGap = await t.js(`(() => {
      const item = document.querySelector('${row(provider, '101')}');
      const name = item.firstElementChild;
      const text = document.createRange();
      text.selectNodeContents(name);
      return item.querySelector('[data-testid="model-capabilities"]').getBoundingClientRect().left - text.getBoundingClientRect().right;
    })()`);
    t.checkNear(`${provider} 短模型名：图标紧跟文字右侧`, shortGap, 8, 2);
  }
  t.ok('长模型名：省略文字后完整保留图标，勾号仍在行尾', await t.js(`(() => {
    const item = document.querySelector('${row('claude', '111')}');
    const name = item.firstElementChild;
    const icons = item.querySelector('[data-testid="model-capabilities"]');
    const check = item.lastElementChild;
    const gap = icons.getBoundingClientRect().left - name.getBoundingClientRect().right;
    const end = item.getBoundingClientRect().right - parseFloat(getComputedStyle(item).paddingRight);
    return name.scrollWidth > name.clientWidth && Math.abs(gap - 8) < 2 && icons.getBoundingClientRect().width >= 52 && Math.abs(end - check.getBoundingClientRect().right) < 2;
  })()`));
  t.check('元数据缺失：不显示任何能力图标', await t.count(`${row('unknown', 'missing')} [data-capability]`), 0);
  const image = `${row('claude', '111')} [data-capability="image"]`;
  await t.js(`document.querySelector('${image}').scrollIntoView({block:'nearest'})`);
  await t.hover(image);
  t.ok('图片图标悬停有提示', await t.waitUntil(`[...document.querySelectorAll('[role=tooltip]')].some(el=>el.textContent === '图片输入' && !el.closest('.ant-tooltip-hidden'))`));
  for (const [capability, label] of [['reasoning', '思考（reasoning）'], ['fast', '支持 Fast 接入']]) {
    await t.hover(`${row('claude', '111')} [data-capability="${capability}"]`);
    t.ok(`${capability} 图标悬停有提示`, await t.waitUntil(`[...document.querySelectorAll('[role=tooltip]')].some(el=>el.textContent === '${label}' && !el.closest('.ant-tooltip-hidden'))`));
  }
  await t.mouse(2, 2);
  await t.shot('capabilities');

  // ——— 本轮新语义：同项目同模型 A 开 / B 关 ———
  t.check('A 外侧快速可见', await t.count(triggerFast), 1);
  t.ok('A 外侧快速文案', (await t.text(triggerFast)) === '· 快速');
  await closePanel(t);

  await choose(t, 'choose-b');
  t.check('B 同项目同模型不显示快速', await t.count(triggerFast), 0);
  await openPanelWithToggle(t);
  t.check('B 开关为关（false 不被 truthy 过滤）', await t.js(pressed), 'false');
  await closePanel(t);

  await choose(t, 'choose-a');
  t.check('切回 A 仍是开启', await t.count(triggerFast), 1);
  await openPanelWithToggle(t);
  t.check('A 往返后仍为开', await t.js(pressed), 'true');

  await t.click(toggle, 12);
  t.ok('点击关闭 Fast', await t.waitUntil(`${pressed} === 'false' && !document.querySelector('${toggle}').disabled`));
  t.ok('A 关闭写回 A 的会话偏好', await t.waitUntil(`${storedFor(a)} === false`));
  t.check('关闭 A 没改 B', await t.js(storedFor(b)), false);
  await closePanel(t);
  t.check('A 关闭后外侧快速消失', await t.count(triggerFast), 0);
  await t.shot('fast-off');

  await choose(t, 'choose-b');
  await openPanelWithToggle(t);
  t.check('A 的关闭没有串到 B（仍是关）', await t.js(pressed), 'false');
  await t.click(toggle, 12);
  t.ok('B 单独开启 Fast', await t.waitUntil(`${pressed} === 'true'`));
  t.ok('B 开启写回 B', await t.waitUntil(`${storedFor(b)} === true`));
  t.check('开启 B 没改 A', await t.js(storedFor(a)), false);
  await closePanel(t);
  t.check('B 开启后外侧显示快速', await t.count(triggerFast), 1);

  await choose(t, 'choose-a');
  t.check('回到 A 仍是关闭（不被 B 覆盖）', await t.count(triggerFast), 0);
  await openPanelWithToggle(t);
  t.check('A 开关仍为关', await t.js(pressed), 'false');
  await closePanel(t);

  // 重载：从宿主记录恢复各自的会话值。
  await t.click('[data-testid="fast-reload"]', 8);
  t.ok('重载后 A 仍是关闭', await t.waitUntil(`document.querySelector('${trigger}') && !document.querySelector('${triggerFast}')`));
  await openPanelWithToggle(t);
  t.check('重载后 A 开关为关', await t.js(pressed), 'false');
  await closePanel(t);
  await choose(t, 'choose-b');
  t.ok('重载后 B 仍是开启', await t.waitFor(triggerFast));
  await openPanelWithToggle(t);
  t.check('重载后 B 开关为开', await t.js(pressed), 'true');
  await closePanel(t);

  // 保存失败可见回滚：只影响这一次点击，A 的确认值不变。
  await choose(t, 'choose-a');
  await openPanelWithToggle(t);
  await t.act('failNext');
  await t.click(toggle, 12);
  t.ok('保存失败显示可见错误', await t.waitFor('[data-testid="model-fast-error"]'));
  t.check('保存失败回滚到确认值（关）', await t.js(pressed), 'false');
  t.check('回滚后外侧仍不显示快速', await t.count(triggerFast), 0);
  t.check('回滚没有写坏 A 的会话偏好', await t.js(storedFor(a)), false);
  await closePanel(t);

  // ——— 原有覆盖：两态配色 / 键盘 / 中英文 / 能力撤销 / 窄屏 ———
  await openPanelWithToggle(t);
  const offColor = await t.style(toggle, ['color', 'background-color']);
  await t.click(toggle, 12);
  t.ok('再次点击可开启 Fast', await t.waitUntil(`${pressed} === 'true' && !document.querySelector('${toggle}').disabled`));
  await t.sleep(120);
  const onColor = await t.style(toggle, ['color', 'background-color']);
  t.ok('开关两态颜色清楚不同', onColor.color !== offColor.color && onColor.backgroundColor !== offColor.backgroundColor);
  await t.js(`document.querySelector('${toggle}').focus()`);
  await t.key('Space');
  t.ok('键盘空格可关闭 Fast', await t.waitUntil(`${pressed} === 'false'`));
  // 每次按键前重新聚焦：重渲染/提示浮层可能拿走焦点。
  await t.js(`document.querySelector('${toggle}').focus()`);
  await t.key('Space');
  t.ok('键盘空格可开启 Fast', await t.waitUntil(`${pressed} === 'true'`));
  t.ok('键盘开启写回当前会话', await t.waitUntil(`${storedFor(a)} === true`));
  await t.setTheme('light');
  t.ok('浅色下开关仍为开启', (await t.js(pressed)) === 'true');
  await t.shot('light');
  await t.js(`document.documentElement.lang='en'`);
  t.ok('英文词条实时生效', await t.waitUntil(`document.querySelector('${toggle}').getAttribute('aria-label').startsWith('Fast is on')`));
  t.check('外侧快速状态支持英文', await t.text(triggerFast), '· Fast');
  await t.js(`document.documentElement.lang='zh-CN'`);
  await t.click(trigger, 20);
  await t.resize(320, 940);
  await t.js(`document.querySelector('${trigger}').scrollIntoView({block:'center'})`);
  await t.click(trigger, 20);
  t.ok('窄屏 Fast 可见', await t.waitFor(toggle));
  t.ok('窄屏不溢出、不遮挡档位', await t.js(`(() => {
    const el = document.querySelector('${toggle}');
    const r = el.getBoundingClientRect();
    const row = document.querySelector('[data-testid="model-level-row"]');
    return r.right <= innerWidth && r.left >= 0 && row.scrollWidth <= row.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
  })()`));
  t.ok('窄屏外侧快速完整显示且按钮不溢出', await t.js(`(() => { const tag = document.querySelector('${triggerFast}').getBoundingClientRect(); const button = document.querySelector('${trigger}').getBoundingClientRect(); return tag.width > 0 && tag.right <= button.right && button.right <= innerWidth; })()`));
  t.ok('窄屏长名称不挤压能力图标', await t.js(`(() => {
    const item = document.querySelector('${row('claude', '111')}');
    const name = item.firstElementChild.getBoundingClientRect();
    const icons = item.querySelector('[data-testid="model-capabilities"]').getBoundingClientRect();
    const check = item.lastElementChild.getBoundingClientRect();
    return Math.abs(icons.left - name.right - 8) < 2 && icons.width >= 52 && icons.right + 7 <= check.left && check.right <= item.getBoundingClientRect().right;
  })()`));
  await t.shot('narrow');
  await t.click(trigger, 20);
  await t.resize(1280, 940);
  await t.js(`document.querySelector('input[data-testid="prov-model-fast-0"]').closest('label').scrollIntoView({block:'center'})`);
  await t.click('label:has(input[data-testid="prov-model-fast-0"])', 8);
  await t.click('[data-testid="fast-save"]', 8);
  await t.js(`document.querySelector('${trigger}').scrollIntoView({block:'center'})`);
  // 能力已撤销：这里只等弹层打开，开关本身应该不存在。
  await openPanel(t);
  t.ok('取消能力后移除闪电控件', await t.waitUntil(`!document.querySelector('${toggle}')`));
  t.check('取消能力后外侧也不显示快速', await t.count(triggerFast), 0);
  t.check('取消能力保留现有档位', await t.count('[data-testid="model-level-row"] .ant-segmented'), 1);
  t.check('取消能力不清除会话自己的 Fast 保存值', await t.js(storedFor(a)), true);
  await closePanel(t);

  // 恢复能力：同一会话的开关按保存值自己回来（不需要重新点）。
  await t.js(`document.querySelector('input[data-testid="prov-model-fast-0"]').closest('label').scrollIntoView({block:'center'})`);
  await t.click('label:has(input[data-testid="prov-model-fast-0"])', 8);
  await t.click('[data-testid="fast-save"]', 8);
  await t.js(`document.querySelector('${trigger}').scrollIntoView({block:'center'})`);
  t.ok('恢复能力后会话 Fast 按保存值恢复显示', await t.waitFor(triggerFast));
  await openPanelWithToggle(t);
  t.check('恢复能力后开关仍是开启', await t.js(pressed), 'true');
  void onColor;
  await closePanel(t);

  // 读取失败：整份偏好读不到时控件不可用并可见报错（Fast 不再是独立的全局 getter，错误由整个控件负责）。
  await t.act('failRead');
  await t.click('[data-testid="fast-reload"]', 8);
  t.ok('读取失败时模型入口不可用', await t.waitUntil(`document.querySelector('${trigger}').disabled === true`));
  await t.shot('read-failed');
}
