import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { selectScenarios } from '../affected.mjs'

test('--changed follows split runner modules without promoting a probe helper or a test fixture', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-selection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'probes'))
  const files = {
    'run.mjs': "import './probe.mjs'; import './distDir.mjs'",
    'probe.mjs': "import './diagnostics.mjs'",
    'diagnostics.mjs': "import './target.mjs'",
    'target.mjs': '', 'distDir.mjs': '', 'fixture.mjs': '',
    'probes/list.mjs': "import '../list-helper.mjs'",
    'probes/toast.mjs': '', 'list-helper.mjs': ''
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
  const select = (name) => selectScenarios({
    changed: [{ file: join(root, name), status: 'M' }],
    harnessDir: root, repo: { root }, graph: { roots: [], files: {} }, scenarios: ['list', 'toast']
  })
  assert.ok(select('target.mjs').all)
  assert.deepEqual(select('list-helper.mjs').picked, ['list'])
  for (const file of ['fixture.mjs', 'distDir.mjs']) {
    assert.equal(select(file).all, null)
    assert.deepEqual(select(file).picked, [])
  }
})
