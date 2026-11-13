import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PackageUpdateStage } from './packageUpdateStage';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gren-package-stage-')); roots.push(root);
  const live = join(root, 'npm'); await mkdir(live); await writeFile(join(live, 'version'), 'old');
  return { root, live, transaction: new PackageUpdateStage({ managedBase: root, liveRoot: live, stageRelative: 'npm', recordsDir: join(root, 'operations') }) };
}
it('prepares in isolation and never mutates the live install on installer failure', async () => {
  const f = await fixture();
  await expect(f.transaction.prepare(async (stage) => { await writeFile(join(stage, 'version'), 'partial'); throw new Error('installer failed'); })).rejects.toThrow('installer failed');
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('old');
  expect(f.transaction.record.state).toBe('prepare-failed');
});
it('switches a prepared unit only under an explicit quiescent lease and retains backup until reload', async () => {
  const f = await fixture();
  await f.transaction.prepare(async (stage) => { await writeFile(join(stage, 'version'), 'new'); });
  await expect(f.transaction.commit({ unitRoot: f.live, quiescent: false }, async () => {}, async () => {})).rejects.toThrow('PACKAGE_CONSUMERS_NOT_QUIESCENT');
  await f.transaction.commit({ unitRoot: f.live, quiescent: true }, async () => {}, async () => {});
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('new');
  expect(await readFile(join(f.transaction.record.backupRoot, 'version'), 'utf8')).toBe('old');
  expect(f.transaction.record.state).toBe('installed');
  await f.transaction.complete(true);
  expect(f.transaction.record.state).toBe('complete');
});
it('configuration commit failure restores the old root without claiming a new runtime loaded', async () => {
  const f = await fixture(); let config = 'old';
  await f.transaction.prepare(async (stage) => { await writeFile(join(stage, 'version'), 'new'); });
  await expect(f.transaction.commit({ unitRoot: f.live, quiescent: true }, async () => { config = 'new'; throw new Error('config failed'); }, async () => { config = 'old'; })).rejects.toThrow('config failed');
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('old');
  expect(config).toBe('old'); expect(f.transaction.record.state).toBe('restored');
});
it('restores a committed root and configuration through the same installation-unit gate', async () => {
  const f = await fixture(); let config = 'old';
  await f.transaction.prepare(async (stage) => { await writeFile(join(stage, 'version'), 'new'); });
  await f.transaction.commit({ unitRoot: f.live, quiescent: true }, async () => { config = 'new'; }, async () => { config = 'old'; });
  await f.transaction.restore({ unitRoot: f.live, quiescent: true }, async () => { config = 'old'; });
  expect(await readFile(join(f.live, 'version'), 'utf8')).toBe('old'); expect(config).toBe('old');
  expect(f.transaction.record.state).toBe('restored');
});
it('rejects a recovered record that redirects destructive paths outside the managed root', async () => {
  const f = await fixture();
  await f.transaction.prepare(async () => {});
  const tampered = { ...f.transaction.record, backupRoot: join(f.root, '..', 'outside') };
  expect(() => PackageUpdateStage.fromRecord(tampered, { managedBase: f.root, liveRoot: f.live, recordsDir: join(f.root, 'operations') })).toThrow('PACKAGE_RECOVERY_PATH_INVALID');
});
