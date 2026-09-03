import { describe, expect, it, vi } from 'vitest';
import { shutdownAll } from './shutdown';

describe('shutdownAll', () => {
  it('runs every target and escalates through killAll', async () => {
    const stopped: string[] = [];
    const targets = [
      { name: 'pi', shutdown: async () => { stopped.push('pi'); } },
      { name: 'panel', shutdown: async () => { stopped.push('panel'); } },
    ];
    const registry = { killAll: vi.fn().mockResolvedValue(undefined) };

    await shutdownAll(targets, registry, 1_000);
    expect(stopped).toEqual(['pi', 'panel']);
    expect(registry.killAll).toHaveBeenCalledOnce();
  });

  it('keeps a target rejection from blocking the others or killAll', async () => {
    const stopped: string[] = [];
    const targets = [
      { name: 'broken', shutdown: async () => { throw new Error('boom'); } },
      { name: 'ok', shutdown: async () => { stopped.push('ok'); } },
    ];
    const registry = { killAll: vi.fn().mockResolvedValue(undefined) };

    await expect(shutdownAll(targets, registry, 1_000)).resolves.toBeUndefined();
    expect(stopped).toEqual(['ok']);
    expect(registry.killAll).toHaveBeenCalledOnce();
  });

  it('escalates to killAll after the grace window when a target hangs', async () => {
    const order: string[] = [];
    const sleep = vi.fn(async () => { order.push('timeout'); });
    const targets = [
      { name: 'hang', shutdown: () => new Promise<void>(() => { order.push('started'); }) },
    ];
    const registry = { killAll: vi.fn(async () => { order.push('killAll'); }) };

    await shutdownAll(targets, registry, 50, sleep);
    expect(order).toEqual(['started', 'timeout', 'killAll']);
    expect(sleep).toHaveBeenCalledWith(50);
  });
});
