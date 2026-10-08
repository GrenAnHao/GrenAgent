/**
 * Electron 入口：加载一个场景页面，跑对应的 probe，汇报结果，按结果设退出码。
 * 由 check.mjs 启动：electron ui-harness/run.mjs（场景名从 UI_SCENARIO 读，UI_SHOW=1 时显示窗口）。
 *
 * 默认静默：离屏渲染（offscreen），不建可见窗口、不进任务栏、不抢焦点，真实鼠标键盘碰不到它。
 * 输入全部走 sendInputEvent 直接送进渲染进程；页面焦点靠 CDP 的焦点模拟，不依赖系统焦点。
 */

import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import config from './harness.config.mjs'
import { distDir } from './distDir.mjs'
import { createProbe, fitViewport } from './probe.mjs'

// 输出被外部截断时（例如 `| head` 提前关掉管道），console.log 会抛 EPIPE
// 把主进程打崩，run 半途死掉、后面的断言跟着莫名失败。这里吞掉写失败。
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const scenario = process.env.UI_SCENARIO
if (!scenario) {
  console.log('缺少 UI_SCENARIO（请用 check.mjs 启动）')
  process.exit(1)
}

const timer = setTimeout(() => {
  console.log(`TIMEOUT ${scenario}（${config.timeoutMs}ms）`)
  app.exit(2)
}, config.timeoutMs)

function finish(code) {
  clearTimeout(timer)
  app.exit(code)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const LEVELS = { verbose: 0, debug: 0, info: 1, warning: 2, error: 3 }
const visible = process.env.UI_SHOW === '1'

/**
 * 焦点模拟：页面始终认为自己有焦点（document.hasFocus() 为 true），focus / blur 事件照常触发。
 * 没有它的话，窗口不是系统前台时 el.focus() 不发 focus 事件，表格这类靠 focus 记「当前格」
 * 的组件会忽略后面的按键。必须在页面加载之后发：加载前发的 CDP 命令会一直挂着。
 */
async function emulateFocus(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach()
    await Promise.race([
      wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }),
      sleep(3000).then(() => {
        throw new Error('3s 无响应')
      })
    ])
  } catch (error) {
    console.log(`  WARN 焦点模拟没开上（${error.message}），依赖 focus 事件的键盘断言可能失败`)
  }
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: config.window.width,
      height: config.window.height,
      useContentSize: true,
      x: 20,
      y: 20,
      // 始终先不显示：静默时是离屏渲染；--show 时加载完用 showInactive 显示，同样不抢焦点。
      // 不要换成「普通窗口 + show: false」：从没显示过的窗口不推进合成器动画，
      // animationend 不触发，组件库的弹层关不掉
      show: false,
      webPreferences: {
        ...config.webPreferences,
        // 窗口被挡住或不可见时也照常跑 rAF / 定时器，否则动画采样和 fps 会停
        backgroundThrottling: false,
        offscreen: !visible
      }
    })
    if (!visible) {
      // 离屏渲染没有显示器驱动，帧率要自己定；默认跟主显示器刷新率一致，动画采样和 fps 才和 --show 可比
      const display = Math.round(screen.getPrimaryDisplay().displayFrequency || 60)
      win.webContents.setFrameRate(Math.min(240, Math.max(1, config.frameRate ?? display)))
    }

    // 页面里的 warning / error 打到终端。Electron 35+ 传一个事件对象（level 是字符串），
    // 更早的版本是 (event, level, message)
    win.webContents.on('console-message', (...args) => {
      const detail = args[0]
      const modern = typeof detail === 'object' && detail !== null && 'message' in detail
      const level = modern ? detail.level : args[1]
      const message = String(modern ? detail.message : args[2])
      const rank = typeof level === 'string' ? (LEVELS[level] ?? 1) : Number(level)
      if (rank >= 2 && !message.includes('Security Warning')) {
        console.log(`  [page] ${message.slice(0, 300)}`)
      }
    })

    await win.loadFile(join(distDir, 'index.html'), { hash: scenario })
    if (visible) win.showInactive()
    // 离屏渲染的视口会比请求的内容区大一两个像素，按实测的 innerWidth / innerHeight 校正
    await fitViewport(win, config.window.width, config.window.height)
    await emulateFocus(win.webContents)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
    await sleep(120)

    // 等 main.tsx 首次 commit 后设上 __uiReady
    const readyBy = Date.now() + config.readyTimeoutMs
    let ready = false
    while (!ready && Date.now() < readyBy) {
      ready = await win.webContents.executeJavaScript('window.__uiReady === true')
      if (!ready) await sleep(100)
    }
    if (!ready) {
      const errors = await win.webContents.executeJavaScript('window.__uiErrors ?? []')
      console.log(`FAIL ${scenario}: 页面没就绪 ${JSON.stringify(errors).slice(0, 500)}`)
      finish(1)
      return
    }

    const probeUrl = new URL(`./probes/${scenario}.mjs`, import.meta.url).href
    const { default: runProbe } = await import(probeUrl)
    const t = createProbe(win, scenario, config)

    console.log(`\n▸ ${scenario}`)
    await runProbe(t)

    // 页面里任何未捕获的错误都算失败（白名单在 harness.config.mjs）
    const pageErrors = await win.webContents.executeJavaScript('window.__uiErrors ?? []')
    for (const error of pageErrors) {
      if (config.ignoredPageErrors.some((pattern) => pattern.test(error))) continue
      t.ok(`无页面异常: ${String(error).slice(0, 160)}`, false)
    }
    // 一条断言都没有的 probe 多半是提前 return 了，不能算通过
    if (t.passed + t.failed === 0) t.ok('probe 至少有一条断言', false)

    console.log(`  ── ${t.passed} passed, ${t.failed} failed`)
    finish(t.failed > 0 ? 1 : 0)
  } catch (error) {
    console.log(`ERROR ${scenario}: ${error?.stack ?? error}`)
    finish(1)
  }
})
