import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const modes = ['assertion','no-shot','page-error','probe-error','strict-miss','timeout','not-ready','zero','pass','destroyed']
const env = { ...process.env, UI_SHOW: '0' }
delete env.ELECTRON_RUN_AS_NODE
function invoke(bin, args, extraEnv) {
  return new Promise(resolve => execFile(bin, args, {
    windowsHide: true, env: { ...env, ...extraEnv }, timeout: 25_000
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })))
}
function readReport(run, expected) {
  assert.equal(run.code, expected, run.output)
  const dir = run.output.match(/失败现场：([^\r\n]+)/)?.[1]
  assert.ok(dir, run.output)
  const raw = readFileSync(join(dir,'failure.json'), 'utf8')
  assert.doesNotMatch(raw, /ui-secret-never-copy-me|<html>|new DataTransfer|document\.body\./)
  return { dir, ...JSON.parse(raw) }
}
// All recursive removals below are of specific private trees created by this test.
function removeTempTree(dir) {
  if (!existsSync(dir)) return
  const rel = relative(realpathSync(tmpdir()), realpathSync(dir))
  assert.ok(!rel.startsWith('..') && !/^[\/\\]/.test(rel) && !rel.includes(':') &&
    /^grenagent-(?:failure-test|failure-fixture)-/.test(rel.split(sep)[0]), dir)
  rmSync(dir, { recursive: true, force: true })
}

test('real offscreen runner preserves first evidence and exit semantics', { timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'grenagent-failure-test-'))
  // No fake cases or build products touch the daily scenario tree. Exercise unchanged
  // production run/check/probe modules against a tiny synthetic compiled window.
  const harness = join(tmp, 'ui-harness')
  mkdirSync(join(harness,'probes'), { recursive: true })
  mkdirSync(join(harness,'scenarios'))
  symlinkSync(realpathSync(join(here,'../node_modules')), join(tmp,'node_modules'), 'junction')
  let dist, shots, failureRoot, retained
  try {
    for (const f of readdirSync(here).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
      copyFileSync(join(here,f), join(harness,f))
    }
    // Same isolation rules as production, but much shorter fixture-only deadlines.
    const originalConfig = pathToFileURL(join(here, 'harness.config.mjs')).href
    writeFileSync(join(harness,'harness.config.mjs'),
      'import config from ' + JSON.stringify(originalConfig) + '; export default {...config, id:' +
      JSON.stringify('grenagent-failure-fixture-' + basename(tmp)) +
      ", window:{width:520,height:260}, timeoutMs:process.env.UI_SCENARIO==='timeout'?2500:12000, readyTimeoutMs:550, failureScreenshotsDisabled:['no-shot']}")
    for (const mode of modes) {
      writeFileSync(join(harness,'scenarios', mode + '.tsx'), '// Only used by check.mjs discovery.')
      copyFileSync(join(here,'failure-fixtures/probe.mjs'), join(harness,'probes', mode + '.mjs'))
    }
    const dirs = await import(pathToFileURL(join(harness,'distDir.mjs')).href)
    ;({ distDir: dist, shotDir: shots, failureRoot } = dirs)
    mkdirSync(dist, { recursive: true })
    copyFileSync(join(here,'failure-fixtures/window.html'), join(dist,'index.html'))
    const run = mode => invoke(electron, [join(harness,'run.mjs')], { UI_SCENARIO: mode })
    const both = await Promise.all([run('assertion'), run('assertion')])
    const [one,two] = both.map(r => readReport(r,1))
    assert.notEqual(one.dir,two.dir)
    for (const r of [one,two]) {
      assert.equal(r.first.kind,'assertion')
      assert.equal(r.first.label,'Receiver count')
      assert.equal(r.first.actual,0)
      assert.equal(r.first.expected,1)
      assert.equal(r.first.stepSeq,r.steps.at(-1).seq)
      assert.deepEqual(r.steps.map(s=>s.kind), ['click','type','insertText','js','act','click'])
      assert.equal(r.window.lastMouseDown.target.testId,'receiver')
      assert.deepEqual(r.steps.at(-1).point, r.window.lastMouseDown.point)
      assert.equal(r.window.focus.tag,'button')
      assert.ok(r.window.lastPasteAt)
      const png = readFileSync(join(r.dir,r.screenshot.file))
      assert.equal(png.subarray(1,4).toString(), 'PNG')
      assert.ok(png.length > 1000)
    }
    for (const r of both) assert.match(r.output, /0 passed, 2 failed/)
    if (process.env.UI_KEEP_FAILURE_EXAMPLE === '1') {
      retained = one.dir
      console.log('Synthetic failure example: ' + retained)
    }
    const noShot = readReport(await run('no-shot'),1)
    assert.deepEqual(noShot.first.label, { type:'string', length:'Dynamic ui-secret-never-copy-me'.length })
    assert.deepEqual(noShot.first.actual, {type:'object'})
    assert.deepEqual(noShot.first.expected, {type:'string',length:23})
    assert.equal(noShot.steps.length,32)
    assert.equal(noShot.steps[0].seq,9)
    assert.equal(noShot.screenshot.status,'disabled')
    assert.equal(existsSync(join(noShot.dir,'window.png')),false)
    assert.equal(noShot.window.lastMouseDown,null)
    for (const [mode, kind] of [['not-ready','not-ready'],['page-error','page-error'],
        ['probe-error','probe-error'],['strict-miss','probe-error'],['zero','no-assertions'],['destroyed','probe-error']]) {
      const report = readReport(await run(mode),1)
      assert.equal(report.first.kind,kind)
      if (mode === 'destroyed') assert.equal(report.window.status,'window-unavailable')
      if (mode === 'strict-miss') {
        assert.equal(report.first.clickReady.reason, 'not-found')
        assert.equal(report.first.clickReady.hit, null)
        assert.equal(report.window.lastMouseDown, null)
      }
    }
    const timeout = readReport(await run('timeout'),2)
    assert.equal(timeout.first.kind,'timeout')
    assert.equal(timeout.window.status,'timed-out')
    const before = readdirSync(failureRoot).length
    const pass = await run('pass')
    assert.equal(pass.code,0,pass.output)
    assert.match(pass.output,/MISS waitFor/)
    assert.equal(readdirSync(failureRoot).length,before)
    assert.ok(existsSync(join(shots,'pass-manual.png')))
    const cli = await invoke(process.execPath,[join(harness,'check.mjs'),'--skip-build','probe-error','pass'])
    assert.equal(cli.code,1,cli.output)
    assert.match(cli.output,/1 passed, 0 failed/)
    assert.match(cli.output,/失败场景：probe-error/)
    const daily = await invoke(process.execPath,[join(here,'check.mjs'),'--list'])
    assert.equal(daily.code,0,daily.output)
    for (const name of modes) assert.ok(!daily.output.split(/\r?\n/).includes(name))
  } finally {
    if (existsSync(join(tmp,'node_modules'))) unlinkSync(join(tmp,'node_modules'))
    removeTempTree(tmp)
    if (dist) removeTempTree(dist)
    if (shots) removeTempTree(shots)
    if (failureRoot && existsSync(failureRoot)) {
      if (retained) {
        const keepRun = dirname(retained)
        for (const name of readdirSync(failureRoot)) if (resolve(failureRoot,name) !== keepRun) removeTempTree(join(failureRoot,name))
      } else removeTempTree(dirname(failureRoot))
    }
  }
})
