import { describe, expect, it } from 'vitest';
import { platformDir, TencentDbLayout } from './layout';

describe('TencentDB runtime layout', () => {
  it('matches the bundled platform directory contract', () => {
    expect(platformDir('win32', 'x64')).toBe('windows-x86_64');
    expect(platformDir('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(platformDir('linux', 'arm64')).toBe('linux-aarch64');
  });

  it('uses resources in packaged mode', () => {
    const layout = new TencentDbLayout({
      resourcesPath: 'C:/app/resources',
      appPath: 'C:/app',
      isPackaged: true,
      platform: 'win32',
      arch: 'x64',
    });
    expect(layout.root.replaceAll('\\', '/')).toBe('C:/app/resources/tencentdb-memory/windows-x86_64');
  });
});
