import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stage = '[data-testid="appearance-stage"]'
const popup = '[data-testid="appearance-popup"]'
const trigger = '[data-testid="appearance-popup-trigger"]'
const evidence = fileURLToPath(new URL('../../../.agents/evidence/2026-10-30-single-workbench-theme/', import.meta.url))
const colors = {
  light: { content: 'rgb(255, 254, 250)', elevated: 'rgb(255, 255, 255)', primary: 'rgb(86, 104, 71)' },
  dark: { content: 'rgb(25, 26, 28)', elevated: 'rgb(43, 44, 46)', primary: 'rgb(173, 195, 153)' },
}

async function surface(t, mode, label) {
  t.ok(`${label}：主题解析完成`, await t.waitUntil(`document.documentElement.dataset.theme === '${mode}'`))
  await t.sleep(450)
  t.checkColor(`${label}：背景沿用专业工作台`, (await t.style(stage, ['background-color'])).backgroundColor, colors[mode].content)
  const selected = `[data-testid="appearance-${mode}"]`
  if (await t.text('[data-testid="appearance-state"]') === mode) {
    t.checkColor(`${label}：选中主题使用固定强调色`, (await t.style(selected, ['border-top-color'])).borderTopColor, colors[mode].primary)
  }
}

async function overlay(t, mode) {
  await t.click(trigger, 20)
  t.check(`${mode}：弹层打开`, await t.countVisible(popup), 1)
  const background = await t.js(`(() => {
    let node = document.querySelector('${popup}')
    while (node && node !== document.body) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
      node = node.parentElement
    }
    return null
  })()`)
  t.checkColor(`${mode}：弹层使用同套浮层色`, background, colors[mode].elevated)
  mkdirSync(evidence, { recursive: true })
  copyFileSync(await t.shot(mode), join(evidence, `appearance-settings-${mode}.png`))
  await t.click(trigger, 20)
  t.check(`${mode}：弹层关闭`, await t.countVisible(popup), 0)
}

export default async function (t) {
  t.ok('外观设置渲染出来', await t.waitFor(stage))
  for (const title of ['配色方案', '主题色', '中性色']) {
    t.check(`已移除${title}选项`, await t.count(`[data-testid="set-card-${title}"]`), 0)
  }
  t.check('保留浅色、深色、跟随系统三个选项', await t.count('[data-testid^="appearance-"][data-testid$="light"], [data-testid="appearance-dark"], [data-testid="appearance-auto"]'), 3)
  t.check('初始字号为14', (await t.text('[data-testid="font-size-stepper"]')).trim(), '14')
  await t.hover('[data-testid="font-size-stepper"]')
  await t.click('[data-testid="font-size-inc"]')
  t.check('点击增大字号后显示15', (await t.text('[data-testid="font-size-stepper"]')).trim(), '15')
  t.check('字号变化应用到对话文字', (await t.style('[data-testid="appearance-font-sample"]', ['font-size'])).fontSize, '15px')
  await t.hover('[data-testid="font-size-stepper"]')
  await t.click('[data-testid="font-size-dec"]')
  t.check('点击减小字号后恢复14', (await t.text('[data-testid="font-size-stepper"]')).trim(), '14')

  await surface(t, 'dark', '初始深色')
  await overlay(t, 'dark')
  await t.click('[data-testid="appearance-light"]', 20)
  t.check('点击浅色后保存浅色偏好', await t.text('[data-testid="appearance-state"]'), 'light')
  await surface(t, 'light', '切换浅色')
  await overlay(t, 'light')
  await t.click('[data-testid="appearance-dark"]', 20)
  t.check('点击深色后保存深色偏好', await t.text('[data-testid="appearance-state"]'), 'dark')
  await surface(t, 'dark', '切回深色')

  await t.win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  })
  await t.click('[data-testid="appearance-auto"]', 20)
  t.check('跟随系统保留独立偏好', await t.text('[data-testid="appearance-state"]'), 'auto')
  await surface(t, 'dark', '跟随系统深色')
  await t.win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await surface(t, 'light', '系统切换浅色')
  t.check('系统变化后仍保存跟随系统', await t.text('[data-testid="appearance-state"]'), 'auto')
  t.check('主题与字号已持久化', await t.js(`(() => {
    const state = JSON.parse(localStorage.getItem('pi-theme')).state
    return { appearance: state.appearance, fontSize: state.fontSize }
  })()`), { appearance: 'auto', fontSize: 14 })
}
