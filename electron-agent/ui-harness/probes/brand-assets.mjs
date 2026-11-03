import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stage = '[data-testid="brand-stage"]'
const evidence = fileURLToPath(new URL('../../../tmp/grenagent-brand-evidence/', import.meta.url))
const q = JSON.stringify
const iconSelectors = [
  '[data-testid="empty-chat-brand"]',
  '.gren-browser-ntp-logo svg',
  '.gren-browser-error-icon svg',
]

async function geometry(t, selector, guest = false) {
  return t.js(`(() => {
    const root = ${guest ? "document.querySelector('[data-testid=\"brand-guest-error\"]').contentDocument" : 'document'};
    const svg = root.querySelector(${q(selector)});
    if (!svg) return null;
    return {
      viewBox: svg.getAttribute('viewBox'),
      paths: [...svg.querySelectorAll('path')].map((path) => {
        const transforms = [];
        let node = path;
        while (node && node !== svg) {
          const transform = node.getAttribute('transform');
          if (transform) transforms.unshift(transform);
          node = node.parentElement;
        }
        return { d: path.getAttribute('d'), transforms };
      }),
    };
  })()`)
}

async function artwork(t, data) {
  t.ok('标题栏保留原文字品牌', await t.waitFor('[data-testid="titlebar-brand"]'))
  t.check('标题栏仍显示 GrenAgent 文字', (await t.text('[data-testid="titlebar-brand"]')).replace(/\s+/g, ''), 'GrenAgent')
  t.check('标题栏不使用图形 Logo', await t.count('[data-testid="titlebar-brand"] svg'), 0)
  for (const selector of ['[data-testid="brand-logo-sample"]']) {
    t.ok(`完整字标存在 ${selector}`, await t.waitFor(selector))
    t.check(`完整 Logo 保留原稿路径、变换和画布 ${selector}`, await geometry(t, selector), data.logo)
  }
  for (const selector of [...iconSelectors, ...data.sizes.map((size) => `[data-testid="brand-icon-${size}"]`)]) {
    t.ok(`独立 G 存在 ${selector}`, await t.waitFor(selector))
    t.check(`独立 G 保留原稿路径、变换和画布 ${selector}`, await geometry(t, selector), data.icon)
  }
  for (const size of data.sizes) {
    const selector = `[data-testid="brand-icon-${size}"]`
    const bounds = await t.rect(selector)
    t.checkNear(`${size}px 图标宽度`, bounds.w, size, 0.5)
    t.checkNear(`${size}px 图标高度`, bounds.h, size, 0.5)
    t.ok(`${size}px 图标具有可访问名称`, await t.js(`(() => {
      const svg = document.querySelector(${q(selector)});
      return svg.getAttribute('role') === 'img' && /GrenAgent/.test(svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '');
    })()`))
    const clip = await t.js(`(() => {
      const svg = document.querySelector(${q(selector)});
      const box = svg.getBBox();
      const view = svg.viewBox.baseVal;
      return box.width > 0 && box.height > 0 && box.x >= view.x && box.y >= view.y && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height;
    })()`)
    t.ok(`${size}px 原始 G 轮廓未裁切`, clip)
  }
  const ratio = await t.rect('[data-testid="brand-logo-sample"]')
  t.checkNear('完整 Logo 保留横版比例', ratio.w / ratio.h, 1514 / 378, 0.03)
  t.check('空会话保留项目上下文', (await t.text('[data-testid="empty-chat-lockup"]')).includes('GrenAgent 项目'), true)
}

async function palette(t, mode) {
  await t.setTheme(mode)
  await t.sleep(500)
  const colors = await t.js(`(() => {
    const selectors = ${q(['[data-testid="brand-logo-sample"]', ...iconSelectors])};
    const probe = document.createElement('span');
    probe.style.color = 'var(--gren-fg)';
    document.querySelector(${q(stage)}).append(probe);
    const foreground = getComputedStyle(probe).color;
    probe.remove();
    return { foreground, fills: selectors.map((selector) => ({ selector, fill: getComputedStyle(document.querySelector(selector).querySelector('path')).fill })) };
  })()`)
  for (const { selector, fill } of colors.fills) {
    t.checkColor(`${mode} 品牌使用中性主题前景 ${selector}`, fill, colors.foreground, 1)
  }
  const expected = mode === 'dark' ? 'rgb(236, 236, 231)' : 'rgb(39, 41, 35)'
  t.checkColor(`${mode} 前景随真实工作台主题切换`, colors.foreground, expected, 1)
  const contrast = await t.js(`(() => {
    const color = (value) => value.match(/[0-9.]+/g).slice(0, 3).map(Number);
    const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, index) => sum + c * [.2126, .7152, .0722][index], 0);
    const fg = luminance(color(${q(colors.foreground)}));
    const bg = luminance(color(getComputedStyle(document.querySelector(${q(stage)})).backgroundColor));
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  })()`)
  t.ok(`${mode} 小尺寸品牌与背景对比度大于 4.5`, contrast > 4.5)
  t.info(`${mode} 品牌实际前景与背景对比度`, contrast)
}

async function screenshot(t, name) {
  mkdirSync(evidence, { recursive: true })
  const path = join(evidence, `brand-assets-${name}.png`)
  copyFileSync(await t.shot(name), path)
  t.info(`品牌证据 ${name}`, path)
}

async function noOverflow(t, label) {
  const result = await t.js(`(() => {
    const root = document.querySelector(${q(stage)});
    const logo = document.querySelector('[data-testid="titlebar-brand"]').getBoundingClientRect();
    return root.scrollWidth <= root.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && logo.right <= innerWidth && logo.left >= 0;
  })()`)
  t.ok(`${label} 标题栏与页面无横向溢出`, result)
}

async function guestError(t, data) {
  await t.act('showGuestError')
  t.ok('真实生成的 guest 错误 HTML 已加载', await t.waitUntil(`Boolean(document.querySelector('[data-testid="brand-guest-error"]')?.contentDocument?.querySelector('.icon svg path'))`))
  t.check('guest 错误文档使用原稿 G 路径、变换和画布', await geometry(t, '.icon svg', true), data.icon)
  const state = await t.js(`(() => {
    const doc = document.querySelector('[data-testid="brand-guest-error"]').contentDocument;
    const icon = doc.querySelector('.icon');
    const svg = icon.querySelector('svg');
    const computed = doc.defaultView.getComputedStyle.bind(doc.defaultView);
    const fill = computed(svg.querySelector('path')).fill;
    const background = computed(doc.body).backgroundColor;
    const color = (value) => value.match(/[0-9.]+/g).slice(0, 3).map(Number);
    const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, index) => sum + c * [.2126, .7152, .0722][index], 0);
    const fg = luminance(color(fill));
    const bg = luminance(color(background));
    return {
      fill,
      heading: computed(doc.querySelector('h1')).color,
      contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05),
      animation: computed(icon).animationName,
      svgAnimation: computed(svg).animationName,
      transform: computed(icon).transform,
      remainsErrorDocument: doc.body.dataset.grenBrowserError === '1' && doc.location.href === 'about:srcdoc',
    };
  })()`)
  t.checkColor('guest 错误页 G 使用中性正文前景', state.fill, state.heading, 1)
  t.ok('guest 错误页 G 与背景对比度大于 4.5', state.contrast > 4.5)
  t.check('guest 错误页 G 不旋转或播放动画', [state.animation, state.svgAnimation, state.transform], ['none', 'none', 'none'])
  t.ok('guest 预览保留真实错误文档且没有导航外网', state.remainsErrorDocument)
  t.info('guest 错误页品牌实际对比度', state.contrast)
  await screenshot(t, 'guest-error')
}

export default async function (t) {
  const data = await t.data()
  t.ok('真实浏览器新页渲染', await t.waitFor('[data-testid="gren-browser-ntp"]'))
  await artwork(t, data)
  await palette(t, 'dark')
  await noOverflow(t, '宽屏深色')
  await screenshot(t, 'dark')
  await palette(t, 'light')
  await noOverflow(t, '宽屏浅色')
  await screenshot(t, 'light')

  const before = await t.resize(480, 880)
  await noOverflow(t, '480px 窄屏')
  const bounds = await t.rect('[data-testid="brand-logo-sample"]')
  t.ok('窄屏横版 Logo 保持可见且不超出视口', bounds.x >= 0 && bounds.right <= 480 && bounds.h > 0)
  await screenshot(t, 'narrow-light')
  await t.resize(...before)
  await t.click('[data-testid="gren-browser-ntp"] .gren-browser-ntp-search', 30)
  t.ok('真实新页搜索按钮仍把焦点交给地址栏', await t.js(`document.activeElement?.closest('.gren-browser-address') !== null`))
  await t.click('.gren-browser-error-reload', 12)
  t.check('真实错误页重试回调仍可触发', (await t.events()).filter((event) => event === 'browser-error:retry').length, 1)
  await guestError(t, data)
}
