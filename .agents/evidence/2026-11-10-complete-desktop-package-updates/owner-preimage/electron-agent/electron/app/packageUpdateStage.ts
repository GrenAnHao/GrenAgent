import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PackageUnitLease { unitRoot: string; quiescent: boolean; }
export interface PackageStageRecord {
  version: 1; operationId: string; managedBase: string; liveRoot: string; recordsDir: string;
  stageRelative: string; container: string; stageRoot: string; backupRoot: string;
  state: 'preparing' | 'prepared' | 'prepare-failed' | 'switching' | 'installed' | 'restoring' | 'restored' | 'complete' | 'recovery-required';
  hadLive: boolean; configCommitted: boolean; diskRestored: boolean;
}
type StageOptions = { managedBase: string; liveRoot: string; recordsDir: string; stageRelative: string };
function inside(root: string, target: string): boolean {
  const value = relative(root, target); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** One installation unit only. The caller owns consent, configuration CAS and runtime leases. */
export class PackageUpdateStage {
  readonly record: PackageStageRecord;
  constructor(options: StageOptions, operationId: string = randomUUID()) {
    const managedBase = resolve(options.managedBase); const liveRoot = resolve(options.liveRoot);
    if (!inside(managedBase, liveRoot) || liveRoot === managedBase || !/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('PACKAGE_RECOVERY_PATH_INVALID');
    if (isAbsolute(options.stageRelative) || options.stageRelative.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) throw new Error('PACKAGE_RECOVERY_PATH_INVALID');
    const container = join(managedBase, `.gren-package-${operationId}`);
    this.record = {
      version: 1, operationId, managedBase, liveRoot, recordsDir: resolve(options.recordsDir), stageRelative: options.stageRelative,
      container, stageRoot: join(container, options.stageRelative), backupRoot: join(managedBase, `.gren-package-backup-${operationId}`),
      state: 'preparing', hadLive: false, configCommitted: false, diskRestored: false,
    };
    this.assertPaths();
  }
  static fromRecord(record: PackageStageRecord, trusted: Pick<StageOptions, 'managedBase' | 'liveRoot' | 'recordsDir'>): PackageUpdateStage {
    if (record.version !== 1 || resolve(record.managedBase) !== resolve(trusted.managedBase) || resolve(record.liveRoot) !== resolve(trusted.liveRoot) || resolve(record.recordsDir) !== resolve(trusted.recordsDir)) throw new Error('PACKAGE_RECOVERY_PATH_INVALID');
    const stage = new PackageUpdateStage({ ...trusted, stageRelative: record.stageRelative }, record.operationId);
    for (const key of ['container', 'stageRoot', 'backupRoot'] as const) if (resolve(record[key]) !== stage.record[key]) throw new Error('PACKAGE_RECOVERY_PATH_INVALID');
    Object.assign(stage.record, record); stage.assertPaths(); return stage;
  }
  private assertPaths(): void {
    const r = this.record;
    for (const target of [r.liveRoot, r.container, r.stageRoot, r.backupRoot]) {
      if (!inside(r.managedBase, resolve(target)) || resolve(target) === r.managedBase) throw new Error('PACKAGE_RECOVERY_PATH_INVALID');
      let ancestor = resolve(target); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      if (existsSync(r.managedBase) && !inside(realpathSync(r.managedBase), realpathSync(ancestor))) throw new Error('PACKAGE_RECOVERY_PATH_INVALID');
    }
  }
  private lease(lease: PackageUnitLease): void {
    if (!lease.quiescent || resolve(lease.unitRoot) !== this.record.liveRoot) throw new Error('PACKAGE_CONSUMERS_NOT_QUIESCENT');
    this.assertPaths();
  }
  private async persist(): Promise<void> {
    await mkdir(this.record.recordsDir, { recursive: true });
    const target = join(this.record.recordsDir, `${this.record.operationId}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(this.record, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, target);
  }
  private async validateLinks(root: string, entry = root): Promise<void> {
    const info = await lstat(entry);
    if (info.isSymbolicLink()) {
      const link = await readlink(entry);
      // Relative in-unit links retain their meaning after the whole root is renamed.
      if (isAbsolute(link) || !inside(root, realpathSync(entry))) throw new Error('PACKAGE_INSTALLATION_NOT_RELOCATABLE');
      return;
    }
    if (info.isDirectory()) for (const name of await readdir(entry)) await this.validateLinks(root, join(entry, name));
  }
  async prepare(installer: (stageRoot: string, container: string) => Promise<void>): Promise<void> {
    this.assertPaths();
    if (this.record.state !== 'preparing') throw new Error('PACKAGE_OPERATION_STATE_INVALID');
    this.record.hadLive = await exists(this.record.liveRoot);
    await this.persist();
    try {
      await mkdir(dirname(this.record.stageRoot), { recursive: true });
      if (this.record.hadLive) {
        await this.validateLinks(this.record.liveRoot);
        await cp(this.record.liveRoot, this.record.stageRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      } else await mkdir(this.record.stageRoot, { recursive: true });
      await installer(this.record.stageRoot, this.record.container);
      this.assertPaths(); await this.validateLinks(this.record.stageRoot);
      this.record.state = 'prepared'; await this.persist();
    } catch (error) {
      this.record.state = 'prepare-failed'; await this.persist(); throw error;
    }
  }
  async commit(lease: PackageUnitLease, configuration: () => Promise<void>, rollbackConfiguration: () => Promise<void>): Promise<void> {
    this.lease(lease);
    if (this.record.state !== 'prepared') throw new Error('PACKAGE_OPERATION_STATE_INVALID');
    this.record.state = 'switching'; await this.persist();
    try {
      if (this.record.hadLive) {
        this.assertPaths();
        try { await rename(this.record.liveRoot, this.record.backupRoot); }
        catch (error) { this.record.diskRestored = true; throw error; }
      }
      this.assertPaths(); await mkdir(dirname(this.record.liveRoot), { recursive: true }); await rename(this.record.stageRoot, this.record.liveRoot);
      await configuration(); this.record.configCommitted = true;
      this.record.state = 'installed'; await this.persist();
    } catch (error) {
      try { await this.restore(lease, rollbackConfiguration); }
      catch { this.record.state = 'recovery-required'; await this.persist(); }
      throw error;
    }
  }
  async restore(lease: PackageUnitLease, configuration: () => Promise<void>): Promise<void> {
    this.lease(lease);
    if (this.record.state === 'complete') throw new Error('PACKAGE_BACKUP_ALREADY_RELEASED');
    this.record.state = 'restoring'; await this.persist();
    try {
      if (await exists(this.record.backupRoot)) {
        if (await exists(this.record.liveRoot)) {
          const rejected = join(this.record.container, 'rejected-install');
          this.assertPaths();
          if (await exists(rejected)) throw new Error('PACKAGE_RECOVERY_DESTINATION_OCCUPIED');
          await mkdir(dirname(rejected), { recursive: true }); await rename(this.record.liveRoot, rejected);
        }
        this.assertPaths(); await rename(this.record.backupRoot, this.record.liveRoot);
      } else if (!this.record.hadLive && await exists(this.record.liveRoot)) {
        const rejected = join(this.record.container, 'rejected-install');
        this.assertPaths(); await mkdir(dirname(rejected), { recursive: true }); await rename(this.record.liveRoot, rejected);
      } else if (this.record.hadLive && (!this.record.diskRestored || !await exists(this.record.liveRoot))) throw new Error('PACKAGE_BACKUP_MISSING');
      this.record.diskRestored = true; await this.persist();
      await configuration(); this.record.configCommitted = false; this.record.state = 'restored'; await this.persist();
    } catch (error) { this.record.state = 'recovery-required'; await this.persist(); throw error; }
  }
  async complete(allConsumersVerified: boolean): Promise<void> {
    if (!allConsumersVerified || this.record.state !== 'installed') throw new Error('PACKAGE_RELOAD_NOT_VERIFIED');
    this.assertPaths();
    this.record.state = 'complete'; await this.persist();
    if (await exists(this.record.backupRoot)) { this.assertPaths(); await rm(this.record.backupRoot, { recursive: true, force: true }); }
    if (await exists(this.record.container)) { this.assertPaths(); await rm(this.record.container, { recursive: true, force: true }); }
  }
}
