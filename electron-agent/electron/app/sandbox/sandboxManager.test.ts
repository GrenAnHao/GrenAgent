import { describe, expect, it, vi } from 'vitest';
import { SandboxManager } from './sandboxManager';

describe('SandboxManager', () => {
  it('rejects write paths for readonly profiles', () => {
    const manager = new SandboxManager({ capabilities: { osIsolation: true } });

    expect(() => manager.run({ profile: 'readonly', writePaths: ['C:/workspace/out.txt'] }, () => 'started'))
      .toThrow('readonly profile does not allow write paths');
  });

  it('keeps workspace cwd and paths inside workspace root', () => {
    const manager = new SandboxManager({ capabilities: { osIsolation: true } });
    const launch = manager.run({
      profile: 'workspace', workspaceRoot: 'C:/workspace', cwd: 'C:/workspace/src',
      readPaths: ['C:/workspace/src'], writePaths: ['C:/workspace/out.txt'],
    }, (options) => options);

    expect(launch.cwd?.toLowerCase()).toContain('workspace\\src');
    expect(() => manager.run({ profile: 'workspace', workspaceRoot: 'C:/workspace', cwd: 'C:/other' }, () => 'started'))
      .toThrow('outside workspace root');
  });

  it('rejects network access when the request disables it', () => {
    const manager = new SandboxManager({ capabilities: { osIsolation: true, networkIsolation: true } });

    expect(() => manager.run({ profile: 'workspace', network: 'none', needsNetwork: true }, () => 'started'))
      .toThrow('network access is disabled');
  });

  it('publishes degradation without changing the requested profile', () => {
    const publish = vi.fn();
    const manager = new SandboxManager({ capabilities: { osIsolation: false }, publish });
    const launch = manager.run({ profile: 'workspace' }, (options) => options);

    expect(launch.profile).toBe('workspace');
    expect(launch.degraded).toBe(true);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'sandbox.degraded', data: expect.objectContaining({ profile: 'workspace' }) }));
  });

  it('does not claim OS isolation when no platform backend is configured', () => {
    const publish = vi.fn();
    const manager = new SandboxManager({ publish });

    const launch = manager.prepare({ profile: 'workspace' });

    expect(launch.degraded).toBe(true);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ capabilities: expect.objectContaining({ osIsolation: false }) }),
    }));
  });
});
