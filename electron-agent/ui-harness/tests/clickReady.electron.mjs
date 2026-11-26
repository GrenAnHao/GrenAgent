// Launched by clickReady.test.mjs; no Vite build or discoverable scenario.
import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { ClickReadyError, createClickReady } from '../clickReady.mjs'
import { createProbe } from '../probe.mjs'

const timer = setTimeout(() => app.exit(2), 20_000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 500, height: 300,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <style>
    button, aside { position:absolute; left:40px; top:40px; height:40px; width:140px; padding:0; border:none }
    button span { display:block; width:100%; height:100% }
    aside { width:22px; background:red }
    </style>
    <button data-testid="click-ready-secret"><span>fixture</span></button><aside></aside>
    <script>
    const target = () => document.querySelector('button')
    const cover = document.querySelector('aside')
    const events = []
    for (const type of ['mousedown','mouseup','click']) document.addEventListener(type, e => {
      events.push([type, e.target.tagName, e.clientX, e.clientY, performance.now()])
    })
    </script>`))
  const t = createProbe(win, 'click-ready-self-test', {})
  const sel = '[data-testid="click-ready-secret"]'
  const point = { x: 46, y: 60 }
  const strict = t.clickReady
  async function noInput(action, reason) {
    await t.js('events.length = 0')
    let failure
    await assert.rejects(action, (err) => {
      assert.ok(err instanceof ClickReadyError)
      assert.equal(err.details.reason, reason)
      assert.ok(!JSON.stringify(err).includes('click-ready-secret'))
      failure = err.details
      return true
    })
    assert.deepEqual(await t.js('events'), [])
    return failure
  }
  assert.equal(await t.hitTest(sel), true, 'center is clear')
  const blocked = await noInput(() => strict(sel, { timeoutMs: 150 }), 'obscured')
  assert.equal(blocked.selector, '[data-testid]')
  assert.deepEqual(blocked.point, point)
  assert.match(blocked.target, /button:nth-of-type\(1\)$/)
  assert.match(blocked.hit, /aside:nth-of-type\(1\)$/)
  await t.click(sel)
  assert.deepEqual(await t.js('events.map(e => e.slice(0,4))'),
    ['mousedown','mouseup','click'].map(event => [event, 'ASIDE', 46, 60]))
  console.log('PASS offset obscured while center is clear: strict dispatches zero; raw still clicks the cover')

  // Set up mutations and start waiting in the same renderer turn. A new interval must start
  // after each mutation; if implementation only measures total wait, event timestamps expose it.
  async function interrupted(setup, expectedPoint) {
    const action = createClickReady({
      js: (code) => t.js(`events.length = 0; cover.hidden = true; ${setup}; ${code}`),
      click: t.click
    })
    assert.deepEqual(await action(sel, { dx: 8, stableMs: 180, timeoutMs: 1800 }), expectedPoint)
    const events = await t.js('events')
    assert.deepEqual(events.map(e => e.slice(0,4)),
      ['mousedown','mouseup','click'].map(event => [event, 'SPAN', expectedPoint.x, expectedPoint.y]))
    assert.ok(events[0][4] - await t.js('window.changedAt') >= 180, 'fresh full stable interval')
  }
  await interrupted(`setTimeout(() => { cover.hidden = false }, 50);
    setTimeout(() => { cover.hidden = true; window.changedAt = performance.now() }, 130)`, { x:48, y:60 })
  await interrupted(`setTimeout(() => {
    target().replaceWith(target().cloneNode(true)); window.changedAt = performance.now()
  }, 90)`, { x:48, y:60 })
  await interrupted(`setTimeout(() => {
    target().style.left = '65px'; window.changedAt = performance.now()
  }, 90)`, { x:73, y:60 })
  console.log('PASS lost hit, node replacement and movement each restart stability; exactly one real click at the checked point')

  await t.js('target().disabled = true')
  await noInput(() => strict(sel, { timeoutMs: 150 }), 'disabled')
  await t.js("target().disabled = false; target().setAttribute('aria-disabled','true')")
  await noInput(() => strict(sel, { timeoutMs: 150 }), 'disabled')
  await t.js("target().removeAttribute('aria-disabled'); target().style.opacity = 0")
  await noInput(() => strict(sel, { timeoutMs: 150 }), 'hidden')
  await t.js("target().style.opacity = 1; setTimeout(() => target().remove(), 65)")
  const gone = await noInput(() => strict(sel, { timeoutMs: 230 }), 'not-found')
  assert.deepEqual([gone.point, gone.hit, gone.target], [null, null, null])
  console.log('PASS disabled, aria-disabled, hidden and unmounted targets: specific reason, zero input')
  clearTimeout(timer)
  app.exit(0)
}).catch((err) => {
  console.error(err)
  clearTimeout(timer)
  app.exit(1)
})
