// 无需 Vite。在 electron-agent/ 运行：node ui-harness/tests/clock.electron.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'
import { createProbeClock } from '../probeClock.mjs'

if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawnSync(electron, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}
const { app, BrowserWindow } = electron
app.setPath('userData', join(app.getPath('temp'), 'grenagent-clock-selfcheck'))
app.on('window-all-closed', () => {}) // 中途主动销毁窗口，还要打开下一个独立场景。
const watchdog = setTimeout(() => {
  console.error('FAIL: 时钟自检超时')
  app.exit(1)
}, 15_000)

async function open(scenario) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  const fixture = new URL('./clock-fixture.html', import.meta.url)
  fixture.hash = scenario
  await win.loadURL(fixture.href)
  const js = (source) => win.webContents.executeJavaScript(source)
  return { win, js, clock: createProbeClock(js) }
}

app.whenReady().then(async () => {
  const { win, js, clock } = await open('attention-toast')
  const before = await js('Date.now()')
  assert.equal(await js('Date.now === nativeClock.now'), false)
  assert.equal(await js('setTimeout === nativeClock.timer && requestAnimationFrame === nativeClock.raf && performance.now === nativeClock.perf'), true)
  // 业务时间不动，两次真正的动画帧、渲染层 timeout 和主进程截止计时都能往前走。
  const [render, hostTimeout] = await Promise.all([
    js(`(async () => {
      const frame = () => new Promise(done => requestAnimationFrame(done))
      const first = await frame()
      const second = await frame()
      await new Promise(resolve => setTimeout(resolve, 10))
      return { first, second, elapsed: performance.now() - first, wall: Date.now() }
    })()`),
    wait(20, 'host timeout fired')
  ])
  assert.equal(hostTimeout, 'host timeout fired')
  assert.equal(render.wall, before)
  assert.ok(render.second > render.first && render.elapsed > 0)
  assert.equal(await clock.advanceBy(0), before)
  assert.equal(await clock.advanceBy(7999), before + 7999)
  assert.equal(await clock.advanceBy(1), before + 8000)
  for (const invalid of [-1, NaN, Infinity, -Infinity, '7']) {
    await assert.rejects(() => clock.advanceBy(invalid), /有限且非负/)
  }
  assert.equal(await js('Date.now()'), before + 8000)
  await js('restoreClock()')
  assert.equal(await js('Date.now === nativeClock.now'), true)
  await assert.rejects(() => clock.advanceBy(1), /未启用/)
  win.destroy()

  // 异常销毁而不显式卸载，也不能把读数或注入的函数带进下一个场景。
  const abandoned = await open('attention-toast')
  await abandoned.clock.advanceBy(86_400_000)
  abandoned.win.destroy()
  const normal = await open('ordinary')
  assert.equal(await normal.js('Date.now === nativeClock.now'), true)
  await assert.rejects(() => normal.clock.advanceBy(1), /未启用/)
  const now = await normal.js('Date.now()')
  await wait(20)
  assert.ok(await normal.js('Date.now()') > now)
  normal.win.destroy()
  console.log('PASS: 墙上时间边界、无效输入、原生帧/定时器、主进程超时、卸载及跨场景隔离')
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
}).finally(() => clearTimeout(watchdog))
