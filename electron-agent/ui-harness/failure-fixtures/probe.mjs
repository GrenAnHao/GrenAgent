// Only the independent runner test copies this file. It is deliberately outside probe discovery.
export default async function (t) {
  const secret = 'ui-secret-' + 'never-copy-me'
  if (t.scenario === 'pass') {
    await t.waitFor('.known-missing', 30)
    await t.shot('manual')
    t.ok('synthetic window is ready', true)
  } else if (t.scenario === 'assertion') {
    await t.click('input')
    await t.type('x')
    await t.insertText(secret)
    // No operating system clipboard is read or modified.
    await t.js(`const clip = new DataTransfer(); clip.setData('text/plain', ${JSON.stringify(secret)});
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: clip }))`)
    await t.act('reset', secret)
    await t.click('[data-testid="receiver"]')
    if (t.check('Receiver count', 0, 1) !== false) throw new Error('synchronous API changed')
    await t.sleep(180)
    await t.js("document.body.replaceChildren('Second observation')")
    if (t.ok('Later assertion ' + secret, false) !== false) throw new Error('synchronous API changed')
  } else if (t.scenario === 'no-shot') {
    for (let i = 0; i < 40; ++i) await t.js('true')
    t.check('Dynamic ' + secret, { html: '<html>' + secret }, secret)
  } else if (t.scenario === 'probe-error') {
    throw new Error('probe stopped: ' + secret)
  } else if (t.scenario === 'strict-miss') {
    await t.clickReady('[data-testid="' + secret + '"]', { timeoutMs: 100 })
  } else if (t.scenario === 'destroyed') {
    t.win.webContents.closeDevTools()
    t.win.destroy()
    throw new Error('synthetic unavailable window')
  } else if (t.scenario === 'timeout') {
    // Leave the Node event loop running but stop the synthetic renderer from responding.
    await t.js('const stop = performance.now() + 8000; while (performance.now() < stop) {}')
  } else if (t.scenario === 'page-error') {
    t.ok('normal assertion before page error check', true)
  }
  // 'zero' returns without an assertion. 'not-ready' never gets to the probe.
}
