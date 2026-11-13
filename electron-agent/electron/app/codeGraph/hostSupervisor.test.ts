import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraphHostSupervisor } from './hostSupervisor';

let now = 1_000_000;
let running = false;
let shouldRun = true;
const start = vi.fn(async () => { running = true; });
const onRecovered = vi.fn();
const onFailed = vi.fn();
let supervisor: CodeGraphHostSupervisor;

beforeEach(() => {
  now = 1_000_000; running = false; shouldRun = true;
  start.mockClear(); onRecovered.mockClear(); onFailed.mockClear();
  start.mockImplementation(async () => { running = true; });
  supervisor = new CodeGraphHostSupervisor({
    isRunning: () => running, start, shouldRun: () => shouldRun,
    now: () => now, onRecovered, onFailed,
  });
});

afterEach(() => supervisor.stop());

describe('codegraph host supervisor', () => {
  it('leaves a healthy host alone', async () => {
    running = true;
    await supervisor.check();
    expect(start).not.toHaveBeenCalled();
  });

  it('relaunches the host without waiting for a new request', async () => {
    await supervisor.check();
    expect(start).toHaveBeenCalledTimes(1);
    expect(running).toBe(true);
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }));
  });

  it('does not relaunch after the user turned maintenance off', async () => {
    shouldRun = false;
    await supervisor.check();
    expect(start).not.toHaveBeenCalled();
  });

  it('backs off after a failed relaunch instead of spinning', async () => {
    start.mockImplementation(async () => { throw new Error('spawn failed'); });
    await supervisor.check();
    expect(onFailed).toHaveBeenCalledTimes(1);
    await supervisor.check();
    // 退避窗口内不再尝试
    expect(start).toHaveBeenCalledTimes(1);
    now += 2_000;
    await supervisor.check();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('resets the failure budget once a relaunch succeeds', async () => {
    start.mockImplementationOnce(async () => { throw new Error('boom'); });
    await supervisor.check();
    expect(onFailed).toHaveBeenCalledTimes(1);
    now += 5_000;
    await supervisor.check();
    expect(running).toBe(true);
    expect(onRecovered).toHaveBeenCalled();
  });

  it('stops after too many consecutive failures rather than looping forever', async () => {
    start.mockImplementation(async () => { throw new Error('always'); });
    for (let i = 0; i < 12; i++) { now += 120_000; await supervisor.check(); }
    expect(start.mock.calls.length).toBeLessThanOrEqual(10);
    // 停手后即便时间过去很久也不再拉
    const calls = start.mock.calls.length;
    now += 600_000;
    await supervisor.check();
    expect(start.mock.calls.length).toBe(calls);
  });

  it('does not start two relaunches concurrently', async () => {
    let release!: () => void;
    start.mockImplementation(() => new Promise<void>((resolve) => { release = () => { running = true; resolve(); }; }));
    const a = supervisor.check();
    const b = supervisor.check();
    release();
    await Promise.all([a, b]);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
