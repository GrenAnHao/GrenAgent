import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createFailureRecorder } from './failure-recorder.mjs'

test('an unwritable evidence directory reports the original failure without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grenagent-no-evidence-'))
  const file = join(dir, 'ordinary-file')
  writeFileSync(file, 'occupied')
  const lines = []
  const recorder = createFailureRecorder({ root: join(file, 'root'), scenario: 'test',
    getWindow: () => null, log: line => lines.push(line) })
  try {
    recorder.fail('not-ready')
    recorder.fail('timeout')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /不可写.*首错：not-ready/)
    assert.equal(readFileSync(file, 'utf8'), 'occupied')
  } finally {
    rmSync(file)
    rmSync(dir, { recursive: true })
  }
})
