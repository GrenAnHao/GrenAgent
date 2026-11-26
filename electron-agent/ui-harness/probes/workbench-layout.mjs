import { checkPageHeading, compareThemeGeometry } from '../workbenchThemeChecks.mjs';
const MAIN = '[data-testid="workbench-main"]';
const VIEW = `${MAIN} [data-find-scope]`;
const PROMPT = '[data-testid="empty-chat-prompt"]';
const SURFACE = '[data-testid="composer-surface"]';
const SEAT = '[data-testid="composer-seat"]';
const EDITOR = `${SURFACE} [contenteditable="true"]`;
const SIDEBAR = '[data-testid="workbench-sidebar"]';
const RAIL = '[data-testid="module-rail"]';
const ROWS = `${SIDEBAR} .pi-session-row`;
const HEADER_TAB = `${MAIN} [data-testid="workspace-tab-chat"]`;
const HEADER_TITLE = `${HEADER_TAB} [data-testid="workspace-tab-title"]`;
const q = JSON.stringify;

async function emptyGeometry(t, label) {
  const geometry = await t.js(`(() => {
    const rect = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right } : null; };
    return { prompt: rect(${q(PROMPT)}), title: rect(${q(`${PROMPT} h1`)}), surface: rect(${q(SURFACE)}), viewport: rect(${q(VIEW)}), seat: rect(${q(SEAT)}) };
  })()`);
  t.info(`${label} 空态几何`, geometry);
  const { prompt, title, surface, viewport, seat } = geometry;
  if (!prompt || !title || !surface || !viewport || !seat) { t.ok(`${label} 标题和真实输入卡均存在`, false); return; }
  t.ok(`${label} 欢迎标题与输入卡整体居中`, Math.abs((prompt.y + seat.bottom) / 2 - (viewport.y + viewport.bottom) / 2) < 32);
  t.ok(`${label} 欢迎标题完整位于输入区上方且不被遮住`, title.y >= viewport.y && title.bottom <= seat.y);
  t.ok(`${label} 标题到输入卡总间距为 16~28px`, surface.y - title.bottom >= 15 && surface.y - title.bottom <= 29);
  t.ok(`${label} 输入卡横向居中`, Math.abs(surface.x + surface.width / 2 - (viewport.x + viewport.width / 2)) < 2);
  t.ok(`${label} 输入卡宽度不超过 880px`, surface.width <= 881);
  const compact = viewport.width <= 620;
  t.ok(`${label} 输入卡高度随实际聊天列收紧`, compact ? surface.height >= 94 && surface.height <= 116 : surface.height >= 119 && surface.height <= 145);
  t.ok(`${label} 输入卡留在内容区内`, surface.x >= viewport.x && surface.right <= viewport.right + 1);
  t.ok(`${label} 普通高度输入卡完整可见`, surface.y >= viewport.y && surface.bottom <= viewport.bottom + 1);
}

async function responsiveGeometry(t, label, expected) {
  const geometry = await t.js(`(() => {
    const main = document.querySelector(${q(MAIN)}).getBoundingClientRect();
    const title = getComputedStyle(document.querySelector(${q(`${PROMPT} h1`)}));
    const surface = document.querySelector(${q(SURFACE)});
    const card = surface.getBoundingClientRect();
    const send = surface.querySelector('[data-testid="composer-send"]');
    const sendRect = send.getBoundingClientRect();
    const hit = document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2);
    const controls = [...surface.querySelectorAll('button, [role="button"], [role="combobox"]')].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    return { columnWidth: main.width, titleFontSize: parseFloat(title.fontSize), surfaceWidth: card.width, surfaceHeight: card.height, leftGap: card.left - main.left, rightGap: main.right - card.right, controlsBounded: controls.length > 0 && controls.every((rect) => rect.left >= card.left - 1 && rect.right <= card.right + 1), sendBounded: sendRect.left >= card.left && sendRect.right <= card.right + 1 && sendRect.top >= 0 && sendRect.bottom <= innerHeight, sendEnabled: !send.disabled && send.getAttribute('aria-disabled') !== 'true', sendHit: send.contains(hit) };
  })()`);
  t.info(`${label} 按实际聊天列采样比例`, geometry);
  t.checkNear(`${label} 输入卡目标宽度`, geometry.surfaceWidth, expected.width, 2);
  t.checkNear(`${label} 输入卡目标高度`, geometry.surfaceHeight, expected.height, 10);
  t.check(`${label} 聊天列宽度不改变一级标题字号`, geometry.titleFontSize, 18);
  t.checkNear(`${label} 输入卡两侧留白对称`, geometry.leftGap, geometry.rightGap, 1);
  t.ok(`${label} 输入控件不横向溢出卡片`, geometry.controlsBounded);
  t.ok(`${label} 发送按钮位于可视卡片内且可用`, geometry.sendBounded && geometry.sendEnabled && geometry.sendHit);
  return geometry;
}

async function composerAtBottom(t, label) {
  const geometry = await t.js(`(() => {
    const seat = document.querySelector(${q(SEAT)}).getBoundingClientRect();
    const viewport = document.querySelector(${q(VIEW)}).getBoundingClientRect();
    return { seatBottom: seat.bottom, viewportBottom: viewport.bottom, windowBottom: innerHeight };
  })()`);
  t.info(`${label} 输入区下沿`, geometry);
  t.ok(`${label} 输入区贴住会话可视区底边`, Math.abs(geometry.seatBottom - geometry.viewportBottom) < 2 && geometry.seatBottom <= geometry.windowBottom + 1);
}

async function noOverflow(t, label) {
  const result = await t.js(`(() => {
    const root = document.documentElement;
    const main = document.querySelector(${q(MAIN)}).getBoundingClientRect();
    const surface = document.querySelector(${q(SURFACE)}).getBoundingClientRect();
    return { page: root.scrollWidth <= innerWidth, main: main.right <= innerWidth + 1, composer: surface.x >= main.x && surface.right <= main.right + 1 };
  })()`);
  t.check(`${label} 页面、主列和输入卡无横向溢出`, result, { page: true, main: true, composer: true });
}

async function transcriptGeometry(t, label) {
  const geometry = await t.js(`(() => {
    const surface = document.querySelector(${q(SURFACE)}).getBoundingClientRect();
    const row = document.querySelector(${q(`${MAIN} [data-find-item]`)});
    const content = row?.firstElementChild?.getBoundingClientRect();
    const scroller = document.querySelector(${q(`${MAIN} [data-testid="chat-scroll"]`)})?.firstElementChild;
    const seat = document.querySelector(${q(SEAT)}).getBoundingClientRect();
    return { surface: { left: surface.left, right: surface.right }, content: content && { left: content.left, right: content.right }, gutter: scroller && scroller.offsetWidth - scroller.clientWidth, seatRight: seat.right, scrollContentRight: scroller && scroller.getBoundingClientRect().left + scroller.clientWidth };
  })()`);
  t.info(`${label} 输入卡与真实消息内容几何`, geometry);
  t.ok(`${label} 输入卡左边缘与真实消息内容对齐`, Boolean(geometry.content) && Math.abs(geometry.surface.left - geometry.content.left) < 1);
  t.ok(`${label} 输入卡右边缘与真实消息内容对齐`, Boolean(geometry.content) && Math.abs(geometry.surface.right - geometry.content.right) < 1);
  t.ok(`${label} 输入区扣除实际滚动条宽度`, Math.abs(geometry.seatRight - geometry.scrollContentRight) < 1);
}

async function markSession(t, title, name) {
  return t.js(`(() => { const row = [...document.querySelectorAll(${q(ROWS)})].find((el) => el.textContent.includes(${q(title)})); row?.setAttribute('data-probe-row', ${q(name)}); return !!row; })()`);
}

async function headerTitle(t, label, expected) {
  t.ok(`${label} 顶部标题同步`, await t.waitUntil(`document.querySelector(${q(HEADER_TITLE)})?.textContent === ${q(expected)}`));
  t.check(`${label} 完整标题保留在悬停提示`, await t.js(`document.querySelector(${q(HEADER_TAB)})?.title`), expected);
}

async function surfaceHierarchy(t, label, dark) {
  const surfaces = await t.js(`(() => {
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixel = (color, under) => {
      context.clearRect(0, 0, 1, 1);
      if (under) { context.fillStyle = under; context.fillRect(0, 0, 1, 1); }
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const rail = background(${q(RAIL)});
    const titlebar = background('[data-testid="workbench-layout"] > [data-tauri-drag-region]');
    const sidebarPane = document.querySelector(${q(SIDEBAR)});
    const railStyle = getComputedStyle(document.querySelector(${q(RAIL)}));
    const sidebarStyle = getComputedStyle(sidebarPane.closest('.ant-draggable-panel'));
    const sidebar = getComputedStyle(sidebarPane.closest('.ant-draggable-panel-fixed')).backgroundColor;
    const composer = getComputedStyle(document.querySelector(${q(SURFACE)}));
    const chat = background(${q(SEAT)});
    const selected = background(${q(RAIL + ' button[aria-pressed="true"]')});
    return {
      rail, titlebar, sidebar, chat, selected, selectedPixel: pixel(selected, rail),
      railBorder: { style: railStyle.borderInlineEndStyle, width: parseFloat(railStyle.borderInlineEndWidth) },
      sidebarBorder: { color: sidebarStyle.borderInlineEndColor, style: sidebarStyle.borderInlineEndStyle, width: parseFloat(sidebarStyle.borderInlineEndWidth) },
      paintPixel: Math.max(1, Math.floor(devicePixelRatio)) / devicePixelRatio,
      composer: composer.backgroundColor, composerBorder: composer.borderTopColor, composerShadow: composer.boxShadow,
      fontSmoothing: getComputedStyle(document.body).getPropertyValue('-webkit-font-smoothing'),
    };
  })()`);
  t.info(`${label} 外壳、聊天画布、输入卡与字体平滑的计算样式`, surfaces);
  const expected = dark
    ? { rail: 'rgb(21, 23, 25)', sidebar: 'rgb(34, 35, 37)', chat: 'rgb(25, 26, 28)', composer: 'rgb(36, 37, 39)' }
    : { rail: 'rgb(236, 238, 235)', sidebar: 'rgb(244, 245, 243)', chat: 'rgb(248, 249, 248)', composer: 'rgb(255, 255, 255)' };
  t.checkColor(`${label} 图标栏底色`, surfaces.rail, expected.rail, 1);
  t.checkColor(`${label} 标题栏与最左图标栏底色一致`, surfaces.titlebar, surfaces.rail, 1);
  t.checkColor(`${label} 会话侧栏底色`, surfaces.sidebar, expected.sidebar, 1);
  t.checkColor(`${label} 聊天画布底色`, surfaces.chat, expected.chat, 1);
  t.checkColor(`${label} 聊天输入卡为独立表面`, surfaces.composer, expected.composer, 1);
  t.check(`${label} ChatView 继承的字体平滑策略`, surfaces.fontSmoothing, 'antialiased');
  const rgb = (pixel) => `rgb(${pixel.slice(0, 3).join(', ')})`;
  if (!dark) {
    t.check('浅色图标轨没有新增占位边框', surfaces.railBorder.width, 0);
    // Chromium at 150% Windows scale snaps 1 CSS px to 1 physical px (0.667 CSS px).
    t.checkNear('浅色二级侧栏保留 1px 分隔线（按系统缩放取整）', surfaces.sidebarBorder.width, surfaces.paintPixel, 0.01);
    t.checkColor('浅色二级侧栏分隔线为冷灰', surfaces.sidebarBorder.color, 'rgba(0, 0, 0, 0.08)', 1);
    t.check('浅色二级侧栏使用实线分割', surfaces.sidebarBorder.style, 'solid');
    t.checkColor('浅色聊天输入卡有冷灰边框', surfaces.composerBorder, 'rgba(0, 0, 0, 0.08)', 1);
    t.checkColor('浅色图标栏选中状态用淡 Sage', surfaces.selected, 'rgba(92, 128, 96, 0.1)', 1);
  }
  t.ok(`${label} 选中背景合成后不同于图标轨底色`, !t.colorNear(rgb(surfaces.selectedPixel), surfaces.rail, dark ? 3 : 0));
  return surfaces;
}

export default async function (t) {
  const data = await t.data();
  t.ok('真实输入卡就绪', await t.waitFor(SURFACE));
  const inspectionPanels = await t.js(`({ request: !!document.querySelector('[data-testid="current-request-details"]'), tree: [...document.querySelectorAll(${q(MAIN)} + ' button')].some(button => button.textContent.includes('会话树与本地文件')) })`);
  t.ok('聊天区不显示请求与缓存预热入口', !inspectionPanels.request);
  t.ok('聊天区不显示会话树入口', !inspectionPanels.tree);
  if (inspectionPanels.request || inspectionPanels.tree) return;
  t.ok('真实空态标题就绪', await t.waitFor(`${PROMPT} h1`));
  t.ok('真实标题栏与模块栏就绪', await t.waitFor('[data-testid="sidebar-toggle"]') && await t.waitFor('[data-testid="module-rail"]'));
  await t.sleep(450);
  await headerTitle(t, '初始会话 A', data.titleA);
  const railGeometry = await t.js(`(() => {
    const rail = document.querySelector('[data-testid="module-rail"]');
    const buttons = [...rail.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
    const icons = [...rail.querySelectorAll('button svg')].map((icon) => { const r = icon.getBoundingClientRect(); return { width: r.width, height: r.height }; });
    return { width: rail.getBoundingClientRect().width, buttons: buttons.map((r) => ({ width: r.width, height: r.height })), icons, rowGap: buttons[1].top - buttons[0].top };
  })()`);
  t.checkNear('导航栏宽度为 52px', railGeometry.width, 52, 0.5);
  t.ok('导航按钮均为 36px', railGeometry.buttons.length >= 4 && railGeometry.buttons.every((r) => Math.abs(r.width - 36) < 0.5 && Math.abs(r.height - 36) < 0.5));
  t.ok('导航图标均为 18px', railGeometry.icons.length >= 4 && railGeometry.icons.every((r) => Math.abs(r.width - 18) < 0.5 && Math.abs(r.height - 18) < 0.5));
  t.checkNear('模块中心间距为 48px', railGeometry.rowGap, 48, 0.5);
  t.ok('选中导航不显示左侧竖条', await t.js(`['none', 'normal', ''].includes(getComputedStyle(document.querySelector('[data-testid="module-chat"]'), '::before').content)`));
  t.ok('空态使用专属布局容器', await t.count('[data-testid="chat-empty-layout"]') === 1);
  t.check('主标题简洁地提出工作目标', await t.text(`${PROMPT} h1`), '想在这里完成什么？');
  t.ok('项目名作为小型上下文显示', (await t.text(PROMPT)).includes('专业工作台'));
  await emptyGeometry(t, '深色大屏');
  await t.click(`${PROMPT} h1`);
  await t.sleep(200);
  const darkSurfaces = await surfaceHierarchy(t, '深色大屏', true);
  const initialSurface = await t.rect(SURFACE);
  t.ok('大屏输入卡充分使用 880px 宽度', initialSurface.w >= 860);
  await noOverflow(t, '深色大屏');
  await t.shot('empty-dark');

  // 真鼠标点击项目/会话，验证外观改动没有破坏 Sidebar 自身的层级和折叠。
  await t.js(`(() => { const row = [...document.querySelectorAll('[data-testid="workbench-sidebar"] .pi-proj-row')].find((el) => el.textContent.includes('专业工作台')); row?.setAttribute('data-probe-project', 'current'); })()`);
  const project = '[data-probe-project="current"]';
  t.ok('当前项目和会话均渲染', await t.waitFor(project) && await markSession(t, data.titleA, 'a') && await markSession(t, data.titleB, 'b'));
  const projectRect = await t.rect(project);
  const childRect = await t.rect('[data-probe-row="a"]');
  t.ok('项目会话位于项目标题下方', childRect.y > projectRect.y);
  const selectedA = await t.style('[data-probe-row="a"]', ['background-color', 'font-weight', 'box-shadow']);
  await t.click('[data-probe-row="b"]', 50);
  t.ok('会话选择回调保留准确路径', (await t.events()).includes(`open:${data.sessionB}`));
  const selectedB = await t.style('[data-probe-row="b"]', ['background-color']);
  t.check('选中背景随当前会话移动', selectedB.backgroundColor, selectedA.backgroundColor);
  t.ok('旧会话取消选中背景', (await t.style('[data-probe-row="a"]', ['background-color'])).backgroundColor !== selectedB.backgroundColor);
  await headerTitle(t, '点击会话 B 后', data.titleB);
  await t.act('renameHeaderSession', data.sessionB, data.RENAMED_B);
  await headerTitle(t, '当前会话原地重命名后', data.RENAMED_B);
  await t.click('[data-probe-row="a"]', 50);
  await headerTitle(t, '切回会话 A 后', data.titleA);
  await t.act('renameHeaderSession', data.sessionB, data.titleB);
  await t.act('headerDraft');
  await headerTitle(t, '空草稿', '新对话');
  await emptyGeometry(t, '切入空草稿');
  await t.click(EDITOR, 25);
  await t.insertText(data.RESTORED_DRAFT);
  await t.js(`window.__draftComposerNode = document.querySelector(${q(EDITOR)})`);
  await t.act('headerSessionA');
  await headerTitle(t, '退出草稿回到会话 A 后', data.titleA);
  await emptyGeometry(t, '从草稿切回会话 A');
  t.ok('切换会话保留同一个编辑器节点', await t.js(`window.__draftComposerNode === document.querySelector(${q(EDITOR)})`));
  await t.act('headerDraft');
  t.ok('切回原草稿恢复未发送正文', await t.waitUntil(`document.querySelector(${q(EDITOR)})?.textContent === ${q(data.RESTORED_DRAFT)}`));
  await emptyGeometry(t, '切回原草稿');
  await t.act('headerDraft', data.NEW_DRAFT_ID);
  t.ok('新建独立草稿不带入原草稿正文', await t.waitUntil(`document.querySelector(${q(EDITOR)})?.textContent === ''`));
  await emptyGeometry(t, '新建独立草稿');
  await t.click(EDITOR, 25);
  await t.insertText(data.NEW_DRAFT_TEXT);
  await t.act('headerDraft');
  t.ok('往返两份草稿保留各自正文', await t.waitUntil(`document.querySelector(${q(EDITOR)})?.textContent === ${q(data.RESTORED_DRAFT)}`));
  t.ok('切换草稿仍保留同一个编辑器节点', await t.js(`window.__draftComposerNode === document.querySelector(${q(EDITOR)})`));
  await t.act('headerDraft', data.NEW_DRAFT_ID);
  t.ok('返回新草稿恢复新正文', await t.waitUntil(`document.querySelector(${q(EDITOR)})?.textContent === ${q(data.NEW_DRAFT_TEXT)}`));
  await t.act('remountChat');
  t.ok('重新挂载真实对话组件恢复草稿正文', await t.waitUntil(`document.querySelector(${q(EDITOR)})?.textContent === ${q(data.NEW_DRAFT_TEXT)}`));
  t.ok('重新挂载实际创建了新的编辑器节点', await t.js(`window.__draftComposerNode !== document.querySelector(${q(EDITOR)})`));
  await emptyGeometry(t, '重新挂载恢复草稿');
  await t.shot('draft-restored-centered');
  await t.act('headerSessionA');
  await headerTitle(t, '草稿恢复验证后回到会话 A', data.titleA);
  t.ok('恢复会话 A 不带入另一份草稿正文', await t.waitUntil(`document.querySelector(${q(EDITOR)})?.textContent === ''`));
  await emptyGeometry(t, '恢复会话 A');
  await t.click(project, 55);
  t.ok('收起项目后其会话消失', await t.waitUntil(`![...document.querySelectorAll(${q(ROWS)})].some((el) => el.textContent.includes(${q(data.titleA)}))`));
  await t.click(project, 55);
  t.ok('重新展开项目恢复会话', await t.waitUntil(`[...document.querySelectorAll(${q(ROWS)})].some((el) => el.textContent.includes(${q(data.titleA)}))`));
  t.ok('独立对话分区仍保留', (await t.text('[data-testid="workbench-sidebar"]')).includes(data.conversationTitle));

  await t.click(EDITOR, 25);
  await t.type(data.DRAFT);
  await t.js(`window.__workbenchEditor = document.querySelector(${q(EDITOR)})`);
  const wide = await responsiveGeometry(t, '宽聊天列', { width: 880, height: 135 });
  t.ok('宽窗实际聊天列至少 1000px', wide.columnWidth >= 1000);
  const windowWidth = await t.js('innerWidth');
  await t.act('sidebarWidth', windowWidth - railGeometry.width - 600);
  await t.sleep(350);
  const compressed = await responsiveGeometry(t, '大窗口侧栏挤窄到 600px 列', { width: 528, height: 104 });
  t.checkNear('大窗口实际聊天列为 600px', compressed.columnWidth, 600, 1);
  await emptyGeometry(t, '大窗口窄聊天列');
  await t.shot('empty-wide-window-narrow-column');
  await t.act('sidebarWidth', 260);
  await t.resize(600 + 260 + railGeometry.width, 880);
  await t.sleep(350);
  const narrow = await responsiveGeometry(t, '小窗口正常侧栏的 600px 列', { width: 528, height: 104 });
  for (const key of ['columnWidth', 'titleFontSize', 'surfaceWidth', 'surfaceHeight', 'leftGap', 'rightGap']) {
    t.checkNear(`两种等宽聊天列的 ${key} 一致`, narrow[key], compressed[key], 1);
  }
  t.ok('窄列保持标题字号，输入卡收紧', narrow.titleFontSize === wide.titleFontSize && narrow.surfaceHeight < wide.surfaceHeight);
  t.ok('600px 窄列每侧保留至少 35px 留白', narrow.leftGap >= 35 && narrow.rightGap >= 35);
  await emptyGeometry(t, '小窗口 600px 聊天列');
  await noOverflow(t, '小窗口 600px 聊天列');
  await t.shot('empty-narrow-window-equal-column');
  await t.resize(444 + 260 + railGeometry.width, 720);
  await t.sleep(350);
  await responsiveGeometry(t, '444px 聊天列', { width: 378, height: 104 });
  await emptyGeometry(t, '444px 聊天列');
  await noOverflow(t, '444px 聊天列');
  await t.shot('empty-responsive-444-column');
  await t.resize(windowWidth, 880);
  await t.sleep(350);
  const restoredWide = await responsiveGeometry(t, '恢复宽聊天列', { width: 880, height: 135 });
  t.checkNear('放大后输入卡恢复原高度', restoredWide.surfaceHeight, wide.surfaceHeight, 1);
  t.ok('宽窄往返不重挂编辑器', await t.js(`window.__workbenchEditor === document.querySelector(${q(EDITOR)})`));
  t.check('宽窄往返不丢草稿正文', await t.text(EDITOR), data.DRAFT);
  await t.resize(1800, 880);
  await t.act('conversation');
  t.ok('消息出现后空态标题收起', await t.waitUntil(`!document.querySelector(${q(PROMPT)})`));
  t.ok('空态切有消息保留同一个编辑器节点', await t.js(`window.__workbenchEditor === document.querySelector(${q(EDITOR)})`));
  t.check('切换布局后草稿原样保留', await t.text(EDITOR), data.DRAFT);
  t.ok('真实消息列表展示最后一行', await t.waitForText(MAIN, data.LAST_LINE));
  await t.sleep(500);
  const conversation = await t.js(`(() => {
    const view = document.querySelector(${q(VIEW)}).getBoundingClientRect();
    const seat = document.querySelector(${q(SEAT)}).getBoundingClientRect();
    const last = [...document.querySelectorAll(${q(`${MAIN} p`)})].find((el) => el.textContent === ${q(data.LAST_LINE)});
    const line = last?.getBoundingClientRect();
    return { bottomGap: view.bottom - seat.bottom, seatTop: seat.top, lineTop: line?.top, lineBottom: line?.bottom, viewTop: view.top };
  })()`);
  t.info('有消息时布局几何', conversation);
  t.ok('有消息时输入框固定在会话底部', Math.abs(conversation.bottomGap) < 2);
  t.ok('末条消息完整可见且不被输入框遮住', conversation.lineTop >= conversation.viewTop && conversation.lineBottom <= conversation.seatTop);
  await transcriptGeometry(t, '深色宽屏对话');
  await noOverflow(t, '深色对话');
  await t.shot('conversation-dark');

  await t.resize(1420, 880);
  await t.act('empty');
  t.ok('恢复空态仍保留同一个编辑器节点', await t.js(`window.__workbenchEditor === document.querySelector(${q(EDITOR)})`));
  t.check('消息态回空态仍保留草稿正文', await t.text(EDITOR), data.DRAFT);
  await emptyGeometry(t, '消息态回空态');
  await t.key('a', ['control']);
  await t.key('Backspace');
  await t.click(`${PROMPT} h1`);
  await compareThemeGeometry(t, '主对话', '[data-testid="workbench-layout"]', 'before');
  await t.shot('theme-paired-dark');
  await t.setTheme('light');
  await compareThemeGeometry(t, '主对话', '[data-testid="workbench-layout"]', 'after');
  await checkPageHeading(t, '主对话空态', PROMPT+' h1');
  await t.shot('theme-paired-light');
  await t.sleep(450);
  await emptyGeometry(t, '浅色大屏');
  const lightSurfaces = await surfaceHierarchy(t, '浅色大屏', false);
  const shadowGeometry = shadow => shadow.replace(/rgba?\([^)]*\)\s*/, '');
  t.check('输入卡阴影的位移、模糊半径与扩散半径跨主题保持一致', shadowGeometry(lightSurfaces.composerShadow), shadowGeometry(darkSurfaces.composerShadow));
  await headerTitle(t, '浅色会话 A', data.titleA);
  t.checkColor('浅色顶部标题使用清楚的深色文字', (await t.style(HEADER_TITLE, ['color'])).color, 'rgb(24, 24, 27)', 1);
  await markSession(t, data.titleA, 'a');
  const activeSession = await t.style('[data-probe-row="a"]', ['background-color', 'color', 'box-shadow', 'font-weight']);
  t.checkColor('浅色选中会话使用淡 Sage', activeSession?.backgroundColor, 'rgba(92, 128, 96, 0.1)', 0);
  t.checkColor('浅色选中会话保留深色标题', activeSession?.color, 'rgb(24, 24, 27)', 0);
  t.check('选中会话在两种主题使用同样字重和内描边', [activeSession?.fontWeight, activeSession?.boxShadow], [selectedA.fontWeight, selectedA.boxShadow]);
  await noOverflow(t, '浅色大屏');
  await t.shot('empty-light');

  await t.resize(760, 720);
  await t.sleep(350);
  await t.act('renameHeaderSession', data.sessionA, data.LONG_TITLE);
  await headerTitle(t, '浅色窄屏超长会话', data.LONG_TITLE);
  const header = await t.js(`(() => {
    const title = document.querySelector(${q(HEADER_TITLE)});
    const style = getComputedStyle(title);
    const titleRect = title.getBoundingClientRect();
    const mainRect = document.querySelector(${q(MAIN)}).getBoundingClientRect();
    const terminal = document.querySelector(${q(`${MAIN} [aria-label="底栏"]`)});
    const subagents = document.querySelector(${q(`${MAIN} [data-testid="subagent-menu-button"]`)});
    const actions = terminal.parentElement;
    const actionRect = actions.getBoundingClientRect();
    const controls = [...actions.querySelectorAll('button, [role="button"]')];
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && rect.left >= mainRect.left && rect.right <= mainRect.right + 1 && element.contains(hit);
    };
    return { clientWidth: title.clientWidth, scrollWidth: title.scrollWidth, overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, titleRight: titleRect.right, actionsLeft: actionRect.left, actionsRight: actionRect.right, mainRight: mainRect.right, controls: controls.length, allControlsVisible: controls.length >= 2 && controls.every(visible), terminalVisible: visible(terminal), subagentsVisible: visible(subagents) };
  })()`);
  t.info('窄屏超长标题与右侧操作几何', header);
  t.ok('窄屏超长标题用单行省略号截断', header.scrollWidth > header.clientWidth + 1 && header.clientWidth > 0 && header.overflow === 'hidden' && header.textOverflow === 'ellipsis' && header.whiteSpace === 'nowrap');
  t.ok('长标题不挤占右侧操作区域', header.titleRight <= header.actionsLeft + 1 && header.actionsRight <= header.mainRight + 1);
  t.ok('窄屏右侧操作均可见且能被指针命中', header.allControlsVisible && header.terminalVisible && header.subagentsVisible);
  await t.shot('header-long-narrow-light');
  await t.act('renameHeaderSession', data.sessionA, data.titleA);
  await headerTitle(t, '窄屏恢复会话 A 原标题后', data.titleA);
  await emptyGeometry(t, '浅色窄屏');
  await noOverflow(t, '浅色窄屏');
  await t.shot('empty-narrow-light');
  await t.act('conversation');
  t.ok('窄屏真实消息列表就绪', await t.waitForText(MAIN, data.LAST_LINE));
  await t.sleep(500);
  await transcriptGeometry(t, '浅色窄屏对话');
  await composerAtBottom(t, '浅色窄屏对话');
  await noOverflow(t, '浅色窄屏对话');
  t.ok('窄屏切换仍保留同一个编辑器节点', await t.js(`window.__workbenchEditor === document.querySelector(${q(EDITOR)})`));
  await t.shot('conversation-narrow-light');
  await t.act('empty');
  await t.click(`${PROMPT} h1`);
  await t.setTheme('dark');
  t.check('从浅色切回后聊天外壳、输入卡与字体平滑恢复深色设置', await surfaceHierarchy(t, '恢复深色', true), darkSurfaces);
  await noOverflow(t, '深色窄屏');
  await t.shot('empty-narrow-dark');

  // 低矮窗口里整组空态原生滚动，可滚到发送入口，正文不随视口变化丢失。
  await t.act('crowdedDraft');
  await t.resize(800, 300);
  await t.sleep(400);
  const emptyScroll = await t.js(`(() => { const view = document.querySelector(${q(VIEW)}); return { clientHeight: view.clientHeight, scrollHeight: view.scrollHeight }; })()`);
  t.info('低矮窗口空态整体原生滚动尺寸', emptyScroll);
  t.ok('低矮窗口的空态整体产生滚动空间', emptyScroll.scrollHeight > emptyScroll.clientHeight + 1);
  await t.wheel(VIEW, 10000);
  t.ok('真实滚轮可以滚动整组空态', await t.waitUntil(`document.querySelector(${q(VIEW)}).scrollTop > 0`));
  t.check('低矮窗口多粘贴块时正文保持原样', await t.text(EDITOR), data.CROWDED_DRAFT);
  const send = await t.js(`(() => {
    const button = document.querySelector(${q(`${SURFACE} [data-testid="composer-send"]`)});
    const rect = button.getBoundingClientRect();
    const viewport = document.querySelector(${q(VIEW)}).getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, viewportTop: viewport.top, windowWidth: innerWidth, windowHeight: innerHeight, hit: button.contains(hit) };
  })()`);
  t.info('低矮窗口发送按钮实际几何与命中', send);
  t.ok('低矮窗口发送按钮完整留在可视区域', send.top >= send.viewportTop && send.bottom <= send.windowHeight && send.left >= 0 && send.right <= send.windowWidth);
  t.ok('低矮窗口发送按钮可被指针命中', send.hit);
  await t.shot('empty-short-crowded');
}
