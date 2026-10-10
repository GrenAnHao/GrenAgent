import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startJobGuard, type GuardChild } from './jobGuard.js';

class FakeGuard extends EventEmitter implements GuardChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  args: string[] = [];
  constructor(onStdinEnd: (guard: FakeGuard) => void = (guard) => { guard.say('swept 2 kept 1'); guard.emit('exit', 0); }) {
    super();
    this.stdin.on('finish', () => onStdinEnd(this));
  }
  say(line: string): void {
    this.stdout.write(`${line}\r\n`);
  }
}

const options = (guard: FakeGuard, over: Record<string, unknown> = {}) => ({
  exePath: 'C:/app/pi-job-guard.exe',
  platform: 'win32' as NodeJS.Platform,
  exists: () => true,
  spawn: vi.fn((_command: string, args: string[], _options: Record<string, unknown>) => { guard.args = args; return guard; }),
  ...over,
});

describe('startJobGuard', () => {
  it('helper 报 ready 后返回守卫；release 关 stdin、等它清理完，返回清理结果', async () => {
    const guard = new FakeGuard();
    const opts = options(guard);
    const starting = startJobGuard(4242, opts);
    guard.say('ready');
    const handle = await starting;
    expect(guard.args).toEqual(['--pid', '4242', '--wait-ms', '15000']);
    expect(opts.spawn.mock.calls[0]![2]).toMatchObject({ detached: true, windowsHide: true });
    await expect(handle!.release()).resolves.toBe('swept 2 kept 1');
  });

  it('重复 release 只清理一次', async () => {
    const onEnd = vi.fn((guard: FakeGuard) => { guard.say('swept 0 kept 0'); guard.emit('exit', 0); });
    const guard = new FakeGuard(onEnd);
    const starting = startJobGuard(1, options(guard));
    guard.say('ready');
    const handle = await starting;
    await Promise.all([handle!.release(), handle!.release()]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('分配失败时带着 helper 的原因 reject', async () => {
    const guard = new FakeGuard();
    const starting = startJobGuard(1, options(guard));
    guard.say('error AssignProcessToJobObject 5');
    await expect(starting).rejects.toThrow('JOB_GUARD_FAILED: error AssignProcessToJobObject 5');
  });

  it('helper 没报 ready 就退出时 reject', async () => {
    const guard = new FakeGuard();
    const starting = startJobGuard(1, options(guard));
    guard.emit('exit', 1);
    await expect(starting).rejects.toThrow('JOB_GUARD_EXITED');
  });

  it('迟迟不报 ready 时超时 reject', async () => {
    const guard = new FakeGuard();
    await expect(startJobGuard(1, options(guard, { readyTimeoutMs: 20 }))).rejects.toThrow('JOB_GUARD_READY_TIMEOUT');
  });

  it('helper 不退出时 release 也有上限', async () => {
    const guard = new FakeGuard(() => {});
    const starting = startJobGuard(1, options(guard, { releaseTimeoutMs: 20 }));
    guard.say('ready');
    const handle = await starting;
    await expect(handle!.release()).resolves.toBe('');
  });

  it('非 Windows 或 helper 不存在时不守卫', async () => {
    const guard = new FakeGuard();
    await expect(startJobGuard(1, options(guard, { platform: 'linux' }))).resolves.toBeUndefined();
    await expect(startJobGuard(1, options(guard, { exists: () => false }))).resolves.toBeUndefined();
  });
});

const realExe = resolve(__dirname, '../../native/bin/pi-job-guard.exe');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform !== 'win32' || !existsSync(realExe))('pi-job-guard.exe', () => {
  it('子进程被直接杀掉后，release 清掉它经 cmd 拉起、已成孤儿的孙进程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-guard-'));
    dirs.push(dir);
    const pidFile = join(dir, 'grand.pid');
    writeFileSync(join(dir, 'grand.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9);`);
    writeFileSync(join(dir, 'host.cjs'), `
      require('node:child_process').spawn('cmd.exe', ['/c', 'node', ${JSON.stringify(join(dir, 'grand.cjs'))}], { stdio: 'ignore', windowsHide: true });
      setInterval(() => {}, 1e9);
    `);
    const host = spawn(process.execPath, [join(dir, 'host.cjs')], { stdio: 'ignore', windowsHide: true });
    const guard = await startJobGuard(host.pid!, { exePath: realExe, waitMs: 5_000 });
    expect(guard).toBeDefined();
    let grand = 0;
    for (let i = 0; i < 100 && !grand; i += 1) {
      if (existsSync(pidFile)) grand = Number(readFileSync(pidFile, 'utf8'));
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive(grand)).toBe(true);
    host.kill();
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(grand)).toBe(true);
    const result = await guard!.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(result).toMatch(/^swept [1-9]\d* kept 0$/);
    expect(alive(grand)).toBe(false);
  }, 30_000);
});
