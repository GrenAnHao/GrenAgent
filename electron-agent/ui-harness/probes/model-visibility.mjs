import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../.agents/evidence/2026-11-11-advanced-parameters-accordion/ui/', import.meta.url));
const q = (id) => `[data-testid="${id}"]`;
const builtin = (kind, id) => q(`prov-builtin-${kind}-${encodeURIComponent(id)}`);
const current = q('model-trigger');
const legacy = `${q('visibility-legacy')} [role="combobox"]`;
const row = (provider, id) => `button[data-provider="${provider}"][data-model-id="${id}"]`;
const selectable = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option:not(.ant-select-item-option-disabled)';
async function click(t, selector) {
  await t.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await t.click(selector, 20);
}
async function close(t) { await t.key('Escape'); }
async function options(t, selector) {
  await close(t);
  await click(t, selector);
  const values = await t.js(`[...document.querySelectorAll(${JSON.stringify(selectable)})].filter(el => el.getBoundingClientRect().height > 0).map(el => el.getAttribute('title') || el.textContent)`);
  await close(t);
  return values;
}
async function legacyOptions(t) {
  await close(t);
  const triggerReady = await t.waitFor(legacy);
  t.ok('旧模型选择入口真实 combobox 存在', triggerReady);
  if (!triggerReady) throw new Error('旧模型入口不存在，不能把缺失候选当作空列表通过');
  t.check('还有候选时旧入口可操作', await t.js(`document.querySelector('${legacy}').disabled`), false);
  await click(t, legacy);
  // This consumer uses LobeHub/base-ui Select, not the AntD selectors used by settings.
  const visibleOptions = `[...document.querySelectorAll('[role="option"]:not([aria-disabled="true"]):not([disabled])')].filter(el => !el.closest('.ant-select-dropdown') && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0)`;
  const opened = await t.waitUntil(`${visibleOptions}.length > 0`);
  t.ok('旧入口确实打开并显示 base-ui 可操作候选', opened);
  if (!opened) throw new Error('旧入口未显示可见候选，不能继续计数');
  const values = await t.js(`${visibleOptions}.map(el => el.textContent)`);
  await close(t);
  return values;
}
async function panel(t) {
  await click(t, current);
  t.ok('当前模型面板仍能打开', await t.waitFor(q('model-level-row')));
}
async function untouched(t, data, fields) {
  const { disk } = await t.act('snapshot');
  t.check('隐藏不改模型覆盖 JSON', disk.modelsJson, data.initialModelsJson);
  t.check('隐藏不改授权信息', disk.authJson, data.authJson);
  t.check('隐藏不改已存设置与路由', disk.settings, data.initialSettings);
  t.check('隐藏不切换当前会话或修改档位/Fast', disk.preferences, data.initialPreferences);
  if (fields) t.check('已选隐藏值只保留回显，不被自动清空', await t.text(q('visibility-saved-fields')), fields);
  t.check('没有参数编辑、配置保存、会话 setter、模型请求或未知 IPC', (await t.events()).filter((event) => event === 'override-edit' || event.endsWith('-edit') || event.startsWith('capability-edit:') || event.startsWith('forbidden:') || event.startsWith('unexpected:')), []);
}
async function reload(t) {
  const boot = (await t.data()).boot;
  await new Promise((resolve) => {
    t.win.webContents.once('did-finish-load', resolve);
    t.win.webContents.reload();
  });
  t.ok('真实页面重载重新初始化 store', await t.waitUntil(`Number(document.querySelector('${q('visibility-root')}')?.dataset.boot) > ${boot}`));
  t.ok('重载后当前会话名称恢复', await t.waitForText(current, 'Visibility Reasoning GPT'));
}
async function shot(t, name) {
  mkdirSync(evidence, { recursive: true });
  copyFileSync(await t.shot(name), join(evidence, `${name}.png`));
}
async function visibilityLabel(t, id) {
  return t.js(`document.querySelector('${builtin('visibility', id)}').getAttribute('aria-label')`);
}
async function visibilityTooltip(t, id, label) {
  const selector = builtin('visibility', id);
  await t.js(`document.querySelector('${selector}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await t.hover(selector, 12);
  t.ok(`显隐图标悬停能读到「${label}」`, await t.waitUntil(`[...document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')].some(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.textContent.includes(${JSON.stringify(label)}))`));
  await t.mouse(2, 2);
}
async function managementFits(t, label) {
  t.ok(`${label} 管理卡和图标头部没有横向溢出`, await t.js(`(() => {
    const section = document.querySelector('${q('visibility-management')}');
    return document.documentElement.scrollWidth <= innerWidth + 1 && section.scrollWidth <= section.clientWidth + 1
      && [...section.querySelectorAll('[data-testid^="prov-model-header-builtin-"]')].every(el => {
        const r = el.getBoundingClientRect();
        return el.scrollWidth <= el.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth + 1;
      });
  })()`));
}

export default async function (t) {
  const data = await t.data();
  t.ok('多卡目录加载完成', await t.waitFor(builtin('row', 'dall-e-3')));
  t.ok('当前会话保留原模型名字', await t.waitForText(current, 'Visibility Reasoning GPT'));
  const fields = await t.text(q('visibility-saved-fields'));
  t.check('所有内置模型同时出现', await t.count('[data-testid^="prov-builtin-row-"]'), 3);
  t.check('管理目录没有模型选择器', await t.count(q('prov-builtin-select')), 0);
  t.check('默认没有展开模型卡正文', await t.count('[data-testid^="prov-model-body-builtin-"]'), 0);
  t.check('已有覆盖才提供恢复默认图标', await t.count('[data-testid^="prov-builtin-reset-"]'), 1);
  t.check('没有覆盖的图片模型不提供恢复默认图标', await t.count(`${builtin('reset', 'gpt-image-1')}, ${builtin('reset', 'dall-e-3')}`), 0);
  t.ok('目录不再逐卡重复跟随默认文字', !(await t.text(q('visibility-management'))).includes('跟随默认'));
  t.check('可见模型显隐图标使用无障碍名称', await visibilityLabel(t, 'gpt-5'), '隐藏模型');
  const headerGeometry = await t.js(`['gpt-5', 'gpt-image-1', 'dall-e-3'].map(id => {
    const header = document.querySelector('[data-testid="prov-model-header-builtin-' + encodeURIComponent(id) + '"]');
    const eye = document.querySelector('[data-testid="prov-builtin-visibility-' + encodeURIComponent(id) + '"]');
    const expand = document.querySelector('[data-testid="prov-model-expand-builtin-' + encodeURIComponent(id) + '"]');
    const h = header.getBoundingClientRect(), e = eye.getBoundingClientRect(), x = expand.getBoundingClientRect();
    return header.contains(eye) && header.contains(expand) && e.top >= h.top - 1 && e.bottom <= h.bottom + 1
      && x.top >= h.top - 1 && x.bottom <= h.bottom + 1
      && Math.abs((e.top + e.height / 2) - (x.top + x.height / 2)) <= 2;
  })`);
  t.ok('所有显隐与展开按钮都位于同一张卡头且垂直居中', headerGeometry.every(Boolean));
  await managementFits(t, '默认宽屏');
  await visibilityTooltip(t, 'gpt-5', '隐藏模型');
  await shot(t, 'model-visibility-overview');
  await click(t, q('prov-model-expand-builtin-gpt-5'));
  await click(t, q('prov-model-expand-builtin-gpt-image-1'));
  t.check('两张卡可以同时独立展开', await t.count(`${q('prov-model-body-builtin-gpt-5')}, ${q('prov-model-body-builtin-gpt-image-1')}`), 2);
  t.check('展开模型卡不会自动打开高级参数组', await t.count(`${q('advanced-builtin-gpt-5')}, ${q('advanced-builtin-gpt-image-1')}`), 0);
  await click(t, q('prov-model-expand-builtin-gpt-5'));
  t.check('收起第一张不影响第二张', await t.count(q('prov-model-body-builtin-gpt-image-1')), 1);
  await click(t, q('prov-model-expand-builtin-gpt-image-1'));
  const first = await t.rect(builtin('row', 'gpt-5'));
  const second = await t.rect(builtin('row', 'gpt-image-1'));
  t.ok('模型卡纵向排列不重叠', second.y >= first.bottom);

  // Each actual consumer is mounted before the visibility mutation.
  t.check('设置单选初始包含全部同供应商模型', (await options(t, q('visibility-single'))).length, 3);
  t.check('路由多选初始包含跨供应商模型', (await options(t, q('visibility-routes'))).length, data.models.length);
  t.check('能力候选去重合并目录与 image presets', (await options(t, q('set-field-IMAGE_MODEL'))).length, 3);
  await click(t, q('prov-diag-toggle'));
  t.ok('测活候选打开但不发送请求', await t.waitFor(q('prov-diag-model')));
  t.check('测活初始模型候选齐全', (await options(t, q('prov-diag-model'))).length, 3);
  await panel(t);
  t.check('合并模型面板初始候选齐全', await t.count('button[data-provider][data-model-id]'), data.models.length);
  await close(t);

  await click(t, builtin('visibility', 'gpt-5'));
  t.check('隐藏后图标无障碍名称立即切换为显示模型', await visibilityLabel(t, 'gpt-5'), '显示模型');
  await visibilityTooltip(t, 'gpt-5', '显示模型');
  t.check('aria-pressed 表示隐藏状态', await t.js(`document.querySelector('${builtin('visibility', 'gpt-5')}').getAttribute('aria-pressed')`), 'true');
  t.check('隐藏后管理卡仍可见', await t.count(builtin('row', 'gpt-5')), 1);
  t.check('隐藏身份使用精确 NUL 分隔键', (await t.act('snapshot')).hidden, ['openai\u0000gpt-5']);
  await panel(t);
  t.check('隐藏当前模型立即从合并候选移除', await t.count(row('openai', 'gpt-5')), 0);
  t.check('其他供应商同 ID 仍可选择', await t.count(row('anthropic', 'gpt-5')), 1);
  t.check('隐藏当前模型仍显示原名字', (await t.text(current)).includes('Visibility Reasoning GPT'), true);
  t.check('隐藏当前模型原高档位保留', await t.js(`document.querySelector('${q('model-level-segmented')} .ant-segmented-item-selected [data-level]')?.dataset.level`), 'high');
  t.check('隐藏当前模型仍保留 Fast 开启', await t.js(`document.querySelector('${q('model-fast-toggle')}')?.getAttribute('aria-pressed')`), 'true');
  t.check('隐藏不误报当前模型不可用', await t.count(q('model-unavailable-hint')), 0);
  await close(t);
  const single = await options(t, q('visibility-single'));
  t.check('设置单选即时过滤隐藏模型', single.length, 2);
  t.ok('设置单选不把当前隐藏值补成可选项', !single.some((value) => value.includes('gpt-5') || value.includes('Reasoning GPT')));
  t.check('路由多选保留当前标签但不补回隐藏候选', (await options(t, q('visibility-routes'))).length, data.models.length - 1);
  t.check('能力候选不因当前值补回隐藏模型', (await options(t, q('set-field-IMAGE_MODEL'))).length, 2);
  t.check('测活即时过滤隐藏模型', (await options(t, q('prov-diag-model'))).length, 2);
  const legacyCandidates = await legacyOptions(t);
  t.check('旧模型选择入口同样过滤隐藏项', legacyCandidates.length, data.models.length - 1);
  t.ok('旧入口不把隐藏当前值自动补成候选', !legacyCandidates.some((value) => value.includes('Visibility Reasoning GPT')));
  t.ok('旧入口仍回显当前隐藏模型名字', (await t.text(legacy)).includes('Visibility Reasoning GPT'));
  await untouched(t, data, fields);
  await shot(t, 'model-visibility-hidden-dark');

  // A real Chromium navigation, not a mocked store rehydrate.
  await reload(t);
  t.check('重载保留精确隐藏身份', (await t.act('snapshot')).hidden, ['openai\u0000gpt-5']);
  t.check('重载管理卡仍能恢复隐藏模型', await t.js(`document.querySelector('${builtin('visibility', 'gpt-5')}').getAttribute('aria-pressed')`), 'true');
  await panel(t);
  t.check('重载后候选仍过滤，原 Fast 能力未丢', [await t.count(row('openai', 'gpt-5')), await t.count(q('model-fast-toggle'))], [0, 1]);
  await close(t);
  await click(t, builtin('visibility', 'gpt-5'));
  t.check('显示后图标名称恢复为隐藏模型', await visibilityLabel(t, 'gpt-5'), '隐藏模型');
  await panel(t);
  t.check('显示操作即时广播恢复候选', await t.count(row('openai', 'gpt-5')), 1);
  await close(t);

  const beforeFailure = await t.act('snapshot');
  await t.act('failStorage', true);
  await click(t, builtin('visibility', 'gpt-5'));
  t.ok('可见性存储失败有真实错误反馈', await t.waitForText(q('visibility-management'), '夹具：可见性存储不可写'));
  t.check('写入失败不发布假隐藏状态', (await t.act('snapshot')).hidden, beforeFailure.hidden);
  t.check('写入失败保留磁盘偏好', (await t.act('snapshot')).storage, beforeFailure.storage);
  t.check('写入失败按钮仍是未隐藏', await t.js(`document.querySelector('${builtin('visibility', 'gpt-5')}').getAttribute('aria-pressed')`), 'false');
  await t.act('failStorage', false);
  await click(t, builtin('visibility', 'gpt-5'));
  t.check('存储恢复后可以再次隐藏', await t.js(`document.querySelector('${builtin('visibility', 'gpt-5')}').getAttribute('aria-pressed')`), 'true');

  // Hide all registered models via their actual management controls, including image presets.
  await click(t, builtin('visibility', 'gpt-image-1'));
  await click(t, builtin('visibility', 'dall-e-3'));
  await click(t, q('manage-anthropic'));
  t.ok('同 ID 在其他供应商初始未隐藏', await t.waitUntil(`document.querySelector('${builtin('visibility', 'gpt-5')}')?.getAttribute('aria-pressed') === 'false'`));
  await click(t, builtin('visibility', 'gpt-5'));
  await panel(t);
  t.check('全隐藏时合并模型候选确实为空', await t.count('button[data-provider][data-model-id]'), 0);
  t.ok('全隐藏显示空候选提示', await t.waitForText('body', '无匹配模型'));
  t.check('全隐藏不丢当前模型 Fast 和推理控件', [await t.count(q('model-fast-toggle')), await t.count(q('model-level-segmented'))], [1, 1]);
  await close(t);
  t.check('全隐藏设置单选不回退旧候选或手填', [(await options(t, q('visibility-single'))).length, await t.count(`input${q('visibility-single')}`)], [0, 0]);
  t.check('全隐藏路由不把已配置隐藏值补回', (await options(t, q('visibility-routes'))).length, 0);
  t.check('全隐藏能力候选不被 presets 复活', (await options(t, q('set-field-IMAGE_MODEL'))).length, 0);
  if (!await t.count(q('prov-diag-model'))) await click(t, q('prov-diag-toggle'));
  t.check('全隐藏测活为空，不回流缓存', (await options(t, q('prov-diag-model'))).length, 0);
  const legacyExists = await t.waitFor(legacy);
  t.ok('全隐藏时旧入口仍保留真实 combobox', legacyExists);
  if (!legacyExists) throw new Error('全隐藏时旧入口丢失，不能以零候选误报通过');
  t.check('全隐藏旧入口禁用，不回流缓存', await t.js(`document.querySelector('${legacy}').disabled`), true);
  t.ok('全隐藏旧入口仍回显已保存模型', (await t.text(legacy)).includes('Visibility Reasoning GPT'));
  await untouched(t, data, fields);
  await shot(t, 'model-visibility-all-hidden');

  await click(t, q('manage-openai'));
  await t.act('replaceImage', true);
  t.ok('同 ID replacement 不渲染重复内置编辑卡', await t.waitUntil(`!document.querySelector('${builtin('row', 'gpt-image-1')}')`));
  t.ok('replacement 的隐藏身份有恢复入口', await t.waitFor(builtin('restore', 'gpt-image-1')));
  await click(t, builtin('restore', 'gpt-image-1'));
  t.ok('replacement 恢复入口真正取消隐藏', !(await t.act('snapshot')).hidden.includes('openai\u0000gpt-image-1'));
  await t.act('replaceImage', false);
  await t.act('externalHidden', 'openai', 'gpt-image-1', true);
  await t.act('deleteImage', true);
  t.ok('目录移除的隐藏模型仍有恢复入口', await t.waitFor(builtin('restore', 'gpt-image-1')));
  await click(t, builtin('restore', 'gpt-image-1'));
  t.ok('目录已删除身份也可恢复', !(await t.act('snapshot')).hidden.includes('openai\u0000gpt-image-1'));
  await t.act('deleteImage', false);
  await click(t, builtin('visibility', 'gpt-5'));
  await panel(t);
  t.check('全隐藏后恢复不会丢候选订阅', await t.count(row('openai', 'gpt-5')), 1);
  await close(t);
  await t.setTheme('light');
  await shot(t, 'model-visibility-restored-light');
  const oldSize = await t.resize(1000, 740);
  await managementFits(t, '窄屏');
  await t.js(`document.querySelector('${builtin('row', 'gpt-5')}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await shot(t, 'compact-model-visibility-narrow-light');
  await t.resize(...oldSize);
  await untouched(t, data, fields);

  await t.act('corruptStorage');
  await reload(t);
  t.check('损坏可见性数据降级为全显示', (await t.act('snapshot')).hidden, []);
  await panel(t);
  t.check('损坏数据不阻断原始目录候选', await t.count('button[data-provider][data-model-id]'), data.models.length);
  t.check('损坏数据仍保留当前 Fast', await t.js(`document.querySelector('${q('model-fast-toggle')}')?.getAttribute('aria-pressed')`), 'true');
  await close(t);
  await untouched(t, data, fields);
}
