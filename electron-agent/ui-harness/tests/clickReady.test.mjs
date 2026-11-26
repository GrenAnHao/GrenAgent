import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

test('strict and raw click actionability in an offscreen Electron window', () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const fixture = fileURLToPath(new URL('./clickReady.electron.mjs', import.meta.url))
  const result = spawnSync(electron, [fixture], { stdio: 'inherit', env, timeout: 30_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0)
})
