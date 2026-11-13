import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../.agents/evidence/2026-11-11-advanced-parameters-accordion/ui/', import.meta.url));
// Keep the existing sparse-override regressions readable while addressing each persistent card by identity.
let activeBuiltin = 'gpt-5';
const q = (id) => {
  const encoded = encodeURIComponent(activeBuiltin);
  if (id.startsWith('prov-model-') || id.startsWith('advanced-')) id = id.replace(/builtin(?=-|$)/, `builtin-${encoded}`);
  if (id === 'prov-builtin-reset') id += `-${encoded}`;
  return `[data-testid="${id}"]`;
};
const input = (id) => `input${q(id)}, textarea${q(id)}, ${q(id)} input, ${q(id)} textarea`;
const option = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option';

async function reveal(t, selector) {
  await t.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
}
async function click(t, id) {
  await reveal(t, q(id));
  await t.click(q(id), 20);
}
async function edit(t, id, text, clearFirst = false) {
  if (id.startsWith('advanced-')) await expand(t, id.startsWith('advanced-builtin-') ? 'builtin' : 0);
  const selector = input(id);
  await reveal(t, selector);
  await t.click(selector, 12);
  await t.key('a', ['control']);
  if (clearFirst || !text) await t.key('Backspace');
  if (clearFirst) t.check('清空继承字段保留空草稿而不立即回填', await value(t, id), '');
  if (text) await t.insertText(text);
  await t.key('Tab');
}
async function value(t, id) {
  return t.js(`document.querySelector(${JSON.stringify(input(id))})?.value`);
}
async function toggle(t, id) {
  const selector = `label:has(input${q(id)}), label:has(${q(id)} input), label${q(id)}`;
  await reveal(t, selector);
  await t.click(selector, 16);
}
async function expand(t, index = 'builtin') {
  const id = `prov-model-expand-${index}`;
  if ((await t.text(q(id)))?.includes('展开')) await click(t, id);
  t.ok(`模型 ${index} 卡片正文展开`, await t.waitFor(q(`prov-model-body-${index}`)));
  const advanced = q(`prov-model-advanced-toggle-${index}`);
  if (await t.js(`document.querySelector(${JSON.stringify(advanced)})?.closest('.ant-collapse-header')?.getAttribute('aria-expanded') === 'false'`)) {
    await click(t, `prov-model-advanced-toggle-${index}`);
  }
  t.ok(`模型 ${index} 展开高级参数组`, await t.waitFor(q(`advanced-${index}`)));
}
async function selectModel(t, id) {
  activeBuiltin = id;
  const found = await t.waitUntil(`document.querySelector(${JSON.stringify(input('prov-model-id-builtin'))})?.value === ${JSON.stringify(id)}`);
  t.ok(`内置模型卡片 ${id} 直接存在`, found);
  if (!found) throw new Error(`未找到内置模型卡片 ${id}`);
}
async function provider(t, id) {
  await click(t, `prov-item-${id}`);
  t.ok(`${id} 内置目录可用`, await t.waitFor(`${q('prov-builtin-models')} [data-model-id]`));
}
async function saves(t, event = 'save') {
  return (await t.events()).filter((entry) => entry === event).length;
}
async function save(t) {
  const before = await saves(t);
  await click(t, 'prov-save');
  t.ok('模型配置真实保存至内存盘', await t.waitUntil(`(window.__uiEvents ?? []).filter(event => event === 'save').length > ${before}`));
  return JSON.parse((await t.data()).savedModelsJson);
}
async function remount(t) {
  const epoch = await t.js(`Number(document.querySelector('${q('builtin-settings-root')}').dataset.epoch)`);
  await t.act('remount');
  t.ok('重新挂载读取配置盘', await t.waitUntil(`Number(document.querySelector('${q('builtin-settings-root')}').dataset.epoch) > ${epoch}`));
  t.ok('重挂后供应商加载', await t.waitFor(q('prov-item-openai')));
}
async function shot(t, name) {
  mkdirSync(evidence, { recursive: true });
  copyFileSync(await t.shot(name), join(evidence, `${name}.png`));
}
async function compactHeaders(t, ids) {
  const geometry = await t.js(`(() => {
    const rect = (id) => document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect();
    const custom = rect('prov-model-card-0');
    return ${JSON.stringify(ids)}.map(id => {
      const suffix = 'builtin-' + encodeURIComponent(id);
      const card = rect('prov-model-card-' + suffix);
      const header = rect('prov-model-header-' + suffix);
      const outer = rect('prov-builtin-row-' + encodeURIComponent(id));
      const eye = rect('prov-builtin-visibility-' + encodeURIComponent(id));
      const expand = rect('prov-model-expand-' + suffix);
      const name = rect('prov-model-name-' + suffix);
      const contains = (r) => r.left >= header.left - 1 && r.right <= header.right + 1
        && r.top >= header.top - 1 && r.bottom <= header.bottom + 1;
      return { id, height: card.height, customHeight: custom.height,
        noToolbar: Math.abs(outer.height - card.height) <= 2,
        sameLine: Math.abs((eye.top + eye.height / 2) - (expand.top + expand.height / 2)) <= 2
          && Math.abs((eye.top + eye.height / 2) - (name.top + name.height / 2)) <= 2,
        insideHeader: contains(eye) && contains(expand),
        fits: card.left >= 0 && card.right <= innerWidth + 1 && header.width <= card.width,
        detailColumn: card.width < innerWidth - 220 };
    });
  })()`);
  for (const item of geometry) {
    // The real custom card has a 32px input, 10px vertical padding and 1px border.
    t.ok(`${item.id} 折叠卡单行高不超过 72px`, item.height > 0 && item.height <= 72);
    t.checkNear(`${item.id} 与原自定义卡一样紧凑`, item.height, item.customHeight, 2);
    t.ok(`${item.id} 显隐与展开同一头部行、没有独立 toolbar`, item.noToolbar && item.sameLine && item.insideHeader);
    t.ok(`${item.id} 实际供应商 detail 列内无横向溢出`, item.fits && item.detailColumn);
  }
}
async function tooltip(t, selector, label) {
  await reveal(t, selector);
  await t.hover(selector, 12);
  t.ok(`图标悬停显示「${label}」Tooltip`, await t.waitUntil(`[...document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')].some(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.textContent.includes(${JSON.stringify(label)}))`));
  await t.mouse(2, 2);
}

export default async function (t) {
  const data = await t.data();
  const [a, b] = data.catalog.openai;
  const [claude] = data.catalog.anthropic;
  t.ok('默认 OpenAI 页面加载内置区', await t.waitFor(q('prov-builtin-models')));
  t.ok('目录读取使用 provider 参数', (await t.events()).includes('catalog:openai'));
  t.check('读取目录不写模型文件', await saves(t, 'save-attempt'), 0);
  t.check('所有内置模型卡同时展示', await t.count(`${q('prov-builtin-models')} [data-testid^="prov-builtin-row-"]`), data.catalog.openai.length);
  t.check('内置目录不再有模型选择 Select', await t.count(q('prov-builtin-select')), 0);
  t.check('初始内置卡折叠', await t.count(`${q('prov-builtin-models')} [data-testid^="prov-model-body-builtin-"]`), 0);
  await selectModel(t, a.id, a.name);
  t.check('选择模型不会自动展开', await t.count(q('prov-model-body-builtin')), 0);
  t.check('内置 ID 只读', await t.js(`document.querySelector('${input('prov-model-id-builtin')}').readOnly`), true);
  t.check('SDK 名称回显', await value(t, 'prov-model-name-builtin'), a.name);
  t.check('自定义追加模型仍在原列表', await value(t, 'prov-model-id-0'), 'custom-fixture');
  t.check('默认目录卡没有恢复默认按钮', await t.count(`${q('prov-builtin-models')} [data-testid^="prov-builtin-reset-"]`), 0);
  t.ok('默认目录卡不重复显示跟随默认', !(await t.text(q('prov-builtin-models'))).includes('跟随默认'));
  t.check('只读内置 ID 不使用 filled 输入底色', await t.js(`document.querySelector('${input('prov-model-id-builtin')}').classList.contains('ant-input-filled')`), false);
  t.check('自定义模型 ID 仍为可编辑 filled 输入', await t.js(`(() => { const el = document.querySelector('${input('prov-model-id-0')}'); return !el.readOnly && el.classList.contains('ant-input-filled'); })()`), true);
  t.check('管理页默认使用真实 1420px 视口', await t.js('innerWidth'), 1420);
  await compactHeaders(t, data.catalog.openai.map((model) => model.id));
  const idWidths = await t.js(`[...document.querySelectorAll('${q('prov-builtin-models')} input[data-testid^="prov-model-id-builtin-"]')].map(el => el.getBoundingClientRect().width)`);
  t.ok('内置 ID 使用一致的紧凑定宽', idWidths.every((width) => width >= 80 && width <= 220 && Math.abs(width - idWidths[0]) <= 2));
  const visibility = q(`prov-builtin-visibility-${encodeURIComponent(a.id)}`);
  t.check('可见模型图标有隐藏模型无障碍名称', await t.js(`document.querySelector('${visibility}').getAttribute('aria-label')`), '隐藏模型');
  t.check('可见模型初始 aria-pressed 为 false', await t.js(`document.querySelector('${visibility}').getAttribute('aria-pressed')`), 'false');
  await tooltip(t, visibility, '隐藏模型');
  await reveal(t, input('prov-model-context-builtin'));
  await t.click(input('prov-model-context-builtin'), 12);
  await t.key('Tab');
  t.check('Tab 可从上下文输入聚焦显隐图标', await t.js(`document.activeElement?.getAttribute('data-testid')`), `prov-builtin-visibility-${encodeURIComponent(a.id)}`);
  await t.key('Tab');
  t.check('下一次 Tab 聚焦同一头部展开按钮', await t.js(`document.activeElement?.getAttribute('data-testid')`), `prov-model-expand-builtin-${encodeURIComponent(a.id)}`);
  await t.key('Tab', ['shift']);
  t.check('Shift+Tab 可回到显隐图标', await t.js(`document.activeElement?.getAttribute('data-testid')`), `prov-builtin-visibility-${encodeURIComponent(a.id)}`);
  for (const theme of ['dark', 'light']) {
    await t.setTheme(theme);
    await t.js(`document.querySelector('${q('prov-builtin-models')}').scrollIntoView({ block: 'start', behavior: 'instant' })`);
    const rows = await t.js(`[...document.querySelectorAll('${q('prov-builtin-models')} [data-testid^="prov-model-card-builtin-"]')].map(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })`);
    t.ok(`${theme} 管理概览截图完整展示多个紧凑模型行`, rows.length >= 2 && rows.every(Boolean));
    await shot(t, `compact-builtin-model-settings-overview-${theme}`);
  }
  await t.setTheme('dark');
  await shot(t, 'builtin-model-settings-overview');
  await expand(t);
  t.check('SDK 最大输出回显', Number(await value(t, 'prov-model-max-tokens-builtin')), a.maxTokens);
  t.check('高级输入不复制 SDK 采样参数', await value(t, 'advanced-builtin-samplingParams'), '');
  t.check('继承 SDK 缓存寿命不作为输入值', await value(t, 'advanced-builtin-promptCache.short'), '');
  t.ok('缓存寿命 placeholder 显示 SDK 值', (await t.js(`document.querySelector('${input('advanced-builtin-promptCache.short')}').placeholder`)).includes(String(a.promptCache.short)));

  await edit(t, 'prov-model-name-builtin', 'A 显式显示名', true);
  t.check('改名后才出现恢复默认图标', await t.count(q('prov-builtin-reset')), 1);
  t.check('恢复默认图标有无障碍名称', await t.js(`document.querySelector('${q('prov-builtin-reset')}').getAttribute('aria-label')`), '恢复默认');
  await tooltip(t, q('prov-builtin-reset'), '恢复参数默认值');
  let disk = await save(t);
  t.check('仅改名称只存一个显式叶子', disk.providers.openai.modelOverrides[a.id], { name: 'A 显式显示名' });
  t.check('未在目录中的旧覆盖保留', disk.providers.openai.modelOverrides['unavailable-fixture'], data.initialDocument.providers.openai.modelOverrides['unavailable-fixture']);

  await edit(t, 'prov-model-context-builtin', '131072');
  await edit(t, 'prov-model-max-tokens-builtin', '4096');
  t.check('SDK 分段计费继承回显', Number((await value(t, 'prov-model-cost-tier-builtin-0-above')).replaceAll(',', '')), a.cost.tiers[0].inputTokensAbove);
  await click(t, 'prov-model-cost-tier-builtin-0-remove');
  t.check('删除最后一档后继承分段不会复活', await t.count(q('prov-model-cost-tier-builtin-0-above')), 0);
  await edit(t, 'prov-model-cost-in-builtin', '0');
  t.check('基础价格修改后已删的 SDK 分段不复活', await t.count(q('prov-model-cost-tier-builtin-0-above')), 0);
  disk = await save(t);
  t.check('删除最后一档显式保存空 tiers', disk.providers.openai.modelOverrides[a.id].cost.tiers, []);
  t.check('输入价格实际编辑为零而非误改其他控件', disk.providers.openai.modelOverrides[a.id].cost.input, 0);
  await edit(t, 'prov-model-map-high-builtin', 'fixture-high');
  await toggle(t, 'prov-model-image-builtin');
  await toggle(t, 'prov-model-fast-builtin');
  await edit(t, 'advanced-builtin-samplingParams', '{"temperature":0,"flag":false}');
  await edit(t, 'advanced-builtin-samplingParamsByThinkingLevel', '{"high":{"top_p":0.2}}');
  await edit(t, 'advanced-builtin-inputLimits.images.maxPerRequest', '2');
  await edit(t, 'advanced-builtin-promptCache.short', '0.5');

  await selectModel(t, b.id, b.name);
  t.check('第二模型初次选择也折叠', await t.count(q('prov-model-body-builtin')), 0);
  await expand(t);
  t.check('展开 B 不收起 A', await t.count('[data-testid="prov-model-body-builtin-gpt-5"]'), 1);
  await edit(t, 'prov-model-name-builtin', 'B 未保存草稿');
  await toggle(t, 'prov-model-reasoning-builtin');
  await edit(t, 'advanced-builtin-samplingParams', '[1]');
  await selectModel(t, a.id, a.name);
  await expand(t);
  t.check('切模型保留 A 基础草稿', await value(t, 'prov-model-name-builtin'), 'A 显式显示名');
  t.check('切模型保留 A 高级草稿', JSON.parse(await value(t, 'advanced-builtin-samplingParams')), { temperature: 0, flag: false });

  await provider(t, 'anthropic');
  await selectModel(t, claude.id, claude.name);
  await expand(t);
  t.check('其他供应商使用自己的 SDK 目录', Number(await value(t, 'prov-model-max-tokens-builtin')), claude.maxTokens);
  await edit(t, 'prov-model-name-builtin', 'Claude 未保存草稿');
  await provider(t, 'openai');
  await selectModel(t, b.id, b.name);
  await expand(t);
  t.check('切供应商保留 B 基础草稿', await value(t, 'prov-model-name-builtin'), 'B 未保存草稿');
  t.check('切模型和供应商保留非法 JSON 原文', await value(t, 'advanced-builtin-samplingParams'), '[1]');
  const invalidAttempts = await saves(t, 'save-attempt');
  await click(t, 'prov-save');
  t.ok('非法 JSON 就地报错', await t.waitForText(q('providers-settings'), '必须是 JSON 对象'));
  t.check('非法 JSON 阻止整个配置写入', await saves(t, 'save-attempt'), invalidAttempts);
  t.check('错误保存不吞掉 JSON 草稿', await value(t, 'advanced-builtin-samplingParams'), '[1]');
  await edit(t, 'advanced-builtin-samplingParams', '{"top_p":0.6}');
  disk = await save(t);
  const overrideA = disk.providers.openai.modelOverrides[a.id];
  t.check('上下文和最大输出落盘', [overrideA.contextWindow, overrideA.maxTokens], [131072, 4096]);
  t.check('零价格与空分段保留且不复制其他价目', { input: overrideA.cost.input, tiers: overrideA.cost.tiers, keys: Object.keys(overrideA.cost).sort() }, { input: 0, tiers: [], keys: ['input', 'tiers'] });
  t.check('档位映射只写更改的叶子', overrideA.thinkingLevelMap, { high: 'fixture-high' });
  t.check('图片能力关闭落盘', overrideA.input, ['text']);
  t.check('Fast 显式 false 不丢失', overrideA.compat, { supportsFastMode: false });
  t.check('采样零与 false 原样落盘', overrideA.samplingParams, { temperature: 0, flag: false });
  t.check('分档采样落盘', overrideA.samplingParamsByThinkingLevel, { high: { top_p: 0.2 } });
  t.check('图片限制不复制 SDK 相邻叶子', overrideA.inputLimits, { images: { maxPerRequest: 2 } });
  t.check('缓存寿命不复制 SDK long', overrideA.promptCache, { short: 0.5 });
  t.check('B 推理能力显式 false 保留', disk.providers.openai.modelOverrides[b.id].reasoning, false);
  t.check('跨供应商草稿一起保存', disk.providers.anthropic.modelOverrides[claude.id], { name: 'Claude 未保存草稿' });
  t.ok('内置覆盖不序列化目录身份或 API', !Object.hasOwn(overrideA, 'id') && !Object.hasOwn(overrideA, 'api'));
  t.check('顶层未知字段保留', disk.futureDocument, data.initialDocument.futureDocument);
  t.check('供应商未知字段保留', disk.providers.openai.futureProvider, data.initialDocument.providers.openai.futureProvider);
  t.check('追加模型未知字段保留', disk.providers.openai.models[0].futureModel, { keep: 'custom' });
  t.ok('UI 草稿字段不落盘', !JSON.stringify(disk).includes('_advanced'));

  await selectModel(t, a.id, a.name);
  await expand(t);
  await click(t, 'prov-model-cost-tier-add-builtin');
  t.ok('新增分段可编辑', await t.waitFor(q('prov-model-cost-tier-builtin-0-out')));
  await edit(t, 'prov-model-cost-tier-builtin-0-out', '');
  t.check('清空分段价格保留空草稿，不立即回填', await value(t, 'prov-model-cost-tier-builtin-0-out'), '');
  disk = await save(t);
  let tierCost = disk.providers.openai.modelOverrides[a.id].cost;
  t.check('清空分段价格以有效基础价格补齐再保存', tierCost.tiers, [{ inputTokensAbove: 100000, input: 0, output: a.cost.output, cacheRead: a.cost.cacheRead, cacheWrite: a.cost.cacheWrite }]);
  t.check('补齐分段不冻结其他基础价格', Object.keys(tierCost).sort(), ['input', 'tiers']);
  await edit(t, 'prov-model-cost-out-builtin', '10');
  disk = await save(t);
  tierCost = disk.providers.openai.modelOverrides[a.id].cost;
  t.check('未填分段价格跟随再次修改的有效基础价格', tierCost.tiers[0].output, 10);
  t.ok('修改一项基础价不冻结 SDK 缓存价格', !Object.hasOwn(tierCost, 'cacheRead') && !Object.hasOwn(tierCost, 'cacheWrite'));
  await edit(t, 'prov-model-cost-tier-builtin-0-above', '');
  t.check('清空阈值保留空草稿', await value(t, 'prov-model-cost-tier-builtin-0-above'), '');
  t.ok('无阈值分段给出保存时忽略说明', (await t.text(q('prov-model-card-builtin'))).includes('没填阈值的分段不会保存'));
  disk = await save(t);
  t.check('无阈值分段跳过且序列化成功', disk.providers.openai.modelOverrides[a.id].cost.tiers, []);

  await selectModel(t, b.id, b.name);
  await expand(t);
  t.ok('B 思考协议初始继承 SDK OpenAI', (await t.text(q('prov-model-format-builtin'))).includes('OpenAI 标准'));
  await click(t, 'prov-model-format-builtin');
  await t.click(`${option}[title^="DeepSeek"]`, 20);
  disk = await save(t);
  t.check('B 显式思考协议覆盖落盘', disk.providers.openai.modelOverrides[b.id].compat.thinkingFormat, 'deepseek');

  await remount(t);
  await selectModel(t, a.id, a.name);
  await expand(t);
  t.check('重挂恢复基础覆盖', Number(await value(t, 'prov-model-max-tokens-builtin')), 4096);
  t.check('重挂恢复采样覆盖', JSON.parse(await value(t, 'advanced-builtin-samplingParams')), { temperature: 0, flag: false });
  t.check('重挂恢复稀疏缓存覆盖', await value(t, 'advanced-builtin-promptCache.short'), '0.5');
  t.check('重挂后空 tiers 不重新继承 SDK 分段', await t.count(q('prov-model-cost-tier-builtin-0-above')), 0);
  await selectModel(t, b.id, b.name);
  await expand(t);
  t.check('重挂后 B 与 A 覆盖隔离', await value(t, 'prov-model-name-builtin'), 'B 未保存草稿');
  t.check('重挂恢复 false 推理能力', await t.js(`document.querySelector('input${q('prov-model-reasoning-builtin')}, ${q('prov-model-reasoning-builtin')} input').checked`), false);
  t.ok('重挂恢复 DeepSeek 思考协议覆盖', (await t.text(q('prov-model-format-builtin'))).includes('DeepSeek'));
  await reveal(t, q('prov-model-format-builtin'));
  await t.hover(q('prov-model-format-builtin'));
  await t.click(`${q('prov-model-format-builtin')} .ant-select-clear`, 6);
  disk = await save(t);
  t.ok('allowClear 删除思考协议覆盖而非复制继承值', !Object.hasOwn(disk.providers.openai.modelOverrides[b.id].compat ?? {}, 'thinkingFormat'));
  await remount(t);
  await selectModel(t, b.id, b.name);
  await expand(t);
  t.ok('清空协议保存重挂恢复 SDK OpenAI 继承', (await t.text(q('prov-model-format-builtin'))).includes('OpenAI 标准'));
  t.check('清协议不删除其他模型参数', await value(t, 'prov-model-name-builtin'), 'B 未保存草稿');
  await provider(t, 'anthropic');
  await selectModel(t, claude.id, claude.name);
  t.check('重挂恢复其他供应商覆盖', await value(t, 'prov-model-name-builtin'), 'Claude 未保存草稿');
  await provider(t, 'openai');
  await selectModel(t, a.id, a.name);
  await expand(t);
  const beforeReset = await saves(t);
  await click(t, `prov-builtin-visibility-${encodeURIComponent(a.id)}`);
  t.check('隐藏立即保存但不写模型参数配置', await saves(t), beforeReset);
  await click(t, 'prov-builtin-reset');
  t.check('清除覆盖与草稿后恢复默认图标消失', await t.count(q('prov-builtin-reset')), 0);
  t.check('恢复参数默认保留当前隐藏偏好', await t.js(`document.querySelector('${q(`prov-builtin-visibility-${encodeURIComponent(a.id)}`)}').getAttribute('aria-pressed')`), 'true');
  t.check('恢复默认只修改表单，不立即写盘', await saves(t), beforeReset);
  t.check('恢复当前模型名称继承', await value(t, 'prov-model-name-builtin'), a.name);
  await expand(t);
  t.check('恢复清空当前高级覆盖与草稿', await value(t, 'advanced-builtin-samplingParams'), '');
  t.check('恢复前磁盘仍保留旧覆盖', JSON.parse((await t.data()).savedModelsJson).providers.openai.modelOverrides[a.id].maxTokens, 4096);
  disk = await save(t);
  t.ok('主保存后才删除当前模型覆盖', !Object.hasOwn(disk.providers.openai.modelOverrides, a.id));
  t.check('恢复 A 不清 B 覆盖', disk.providers.openai.modelOverrides[b.id].reasoning, false);
  t.check('恢复 A 不清另一供应商覆盖', disk.providers.anthropic.modelOverrides[claude.id], { name: 'Claude 未保存草稿' });
  t.check('恢复 A 不清不可用模型覆盖', disk.providers.openai.modelOverrides['unavailable-fixture'], data.initialDocument.providers.openai.modelOverrides['unavailable-fixture']);

  await edit(t, 'advanced-builtin-promptCache.short', '60');
  await save(t);
  await edit(t, 'advanced-builtin-promptCache.short', '');
  disk = await save(t);
  t.ok('清空单个高级字段恢复 SDK 继承', !Object.hasOwn(disk.providers.openai.modelOverrides?.[a.id]?.promptCache ?? {}, 'short'));
  t.check('清空输入后仍显示 SDK placeholder', await value(t, 'advanced-builtin-promptCache.short'), '');

  await t.act('failSave', true);
  const diskBeforeFailure = (await t.data()).savedModelsJson;
  await edit(t, 'prov-model-name-builtin', 'A 保存失败草稿');
  await click(t, 'prov-save');
  t.ok('保存失败反馈原始原因', await t.waitForText(q('providers-settings'), '夹具：磁盘不可写'));
  t.check('失败不改内存盘', (await t.data()).savedModelsJson, diskBeforeFailure);
  t.check('失败保留当前模型草稿', await value(t, 'prov-model-name-builtin'), 'A 保存失败草稿');
  await t.act('failSave', false);
  await t.act('partialRefresh', true);
  await save(t);
  t.ok('写盘成功但刷新失败有独立反馈', await t.waitForText(q('providers-settings'), '已保存'));
  t.ok('刷新失败可仅重试生效', await t.waitFor(q('prov-refresh-only')));
  const writesBeforeRefresh = await saves(t, 'save-attempt');
  await t.act('failRefresh', true);
  await click(t, 'prov-refresh-only');
  t.ok('仅刷新失败仍保留错误', await t.waitForText(q('providers-settings'), '夹具：仅刷新失败'));
  await t.act('failRefresh', false);
  await click(t, 'prov-refresh-only');
  t.ok('仅刷新重试成功后移除重试按钮', await t.waitUntil(`!document.querySelector('${q('prov-refresh-only')}')`));
  t.check('仅刷新失败与重试均不重复写盘', await saves(t, 'save-attempt'), writesBeforeRefresh);
  t.check('两次仅刷新都走独立命令', await saves(t, 'refresh-only'), 2);
  await t.act('partialRefresh', false);

  await expand(t, 0);
  await edit(t, 'prov-model-max-tokens-0', '7000');
  disk = await save(t);
  t.check('自定义追加模型仍可原地编辑', disk.providers.openai.models[0].maxTokens, 7000);
  await edit(t, 'prov-model-id-0', b.id);
  disk = await save(t);
  t.check('同 ID 自定义替换仍存在 models 数组', disk.providers.openai.models[0].id, b.id);
  t.check('同 ID 自定义替换不重复渲染内置卡', await t.count(`[data-testid="prov-builtin-row-${encodeURIComponent(b.id)}"]`), 0);
  t.check('替换模型只保留下方自定义编辑卡', await value(t, 'prov-model-id-0'), b.id);
  await selectModel(t, a.id, a.name);
  await expand(t);

  await t.setTheme('dark');
  await reveal(t, q('advanced-builtin'));
  const darkBackground = (await t.style(q('builtin-settings-root'), ['background-color'])).backgroundColor;
  await shot(t, 'builtin-model-settings-dark');
  await t.setTheme('light');
  const lightBackground = (await t.style(q('builtin-settings-root'), ['background-color'])).backgroundColor;
  t.ok('深浅主题切换应用真实表面色', darkBackground !== lightBackground);
  await shot(t, 'builtin-model-settings-light');
  const oldSize = await t.resize(780, 740);
  for (const theme of ['light', 'dark']) {
    await t.setTheme(theme);
    await reveal(t, q('advanced-builtin'));
    const geometry = await t.js(`(() => {
      const root = document.querySelector('${q('providers-settings')}');
      const section = document.querySelector('${q('prov-builtin-models')}');
      const field = document.querySelector('${input('advanced-builtin-samplingParams')}').getBoundingClientRect();
      return { documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
        rootFits: root.scrollWidth <= root.clientWidth + 1, sectionFits: section.scrollWidth <= section.clientWidth + 1,
        headersFit: [...section.querySelectorAll('[data-testid^="prov-model-header-builtin-"]')].every(el => {
          const r = el.getBoundingClientRect();
          return el.scrollWidth <= el.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth + 1;
        }),
        fieldFits: field.left >= 0 && field.right <= innerWidth + 1 && field.width > 120 };
    })()`);
    t.ok(`${theme} 窄屏无横向溢出且高级输入可用`, Object.values(geometry).every(Boolean));
    await shot(t, `builtin-model-settings-narrow-${theme}`);
  }
  await t.resize(...oldSize);

  await t.act('failCatalog', 'openai', true);
  await remount(t);
  t.ok('目录失败说明原因', await t.waitForText(q('prov-builtin-models'), '夹具：openai 目录不可用'));
  t.ok('目录失败出现重试入口', await t.waitFor(q('prov-builtin-retry')));
  const attempts = (await t.events()).filter((event) => event === 'catalog:openai').length;
  const writesBeforeCatalogRetry = await saves(t, 'save-attempt');
  await t.act('failCatalog', 'openai', false);
  await click(t, 'prov-builtin-retry');
  t.ok('目录重试重新请求当前 provider', await t.waitUntil(`(window.__uiEvents ?? []).filter(event => event === 'catalog:openai').length > ${attempts}`));
  await selectModel(t, a.id, a.name);
  t.check('目录失败恢复后已保存覆盖仍在', await value(t, 'prov-model-name-builtin'), 'A 保存失败草稿');
  t.check('目录重试不写盘', await saves(t, 'save-attempt'), writesBeforeCatalogRetry);
  t.check('全程不写凭据、不登录、不请求模型、无未装桩命令', (await t.events()).filter((event) => event.startsWith('forbidden:') || event.startsWith('unexpected:')), []);
}
