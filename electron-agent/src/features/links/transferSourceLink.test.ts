import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeAppLink } from './routeAppLink';

const openWorkspaceFile = vi.fn(async (..._args: string[]) => 'dock');
vi.mock('../dock/openWorkspaceFile', () => ({ openWorkspaceFile: (...args: string[]) => openWorkspaceFile(...args) }));
vi.mock('../dock/browser/openInAppBrowser', () => ({ openInAppBrowser: () => true }));
vi.mock('../../platform/runtime', () => ({ openUrl: vi.fn(async () => {}) }));

beforeEach(() => openWorkspaceFile.mockClear());

describe('historical Markdown file sources', () => {
  it('opens old relative links from the original root, not a target project with the same name', async () => {
    const notify = vi.fn();
    await routeAppLink('src/config.ts', { workspace: '/target', sourceCwd: '/old', system: false, notify });
    expect(openWorkspaceFile).toHaveBeenCalledWith('/old/src/config.ts', '/old');
    expect(notify).not.toHaveBeenCalled();
    await routeAppLink('src/config.ts', { workspace: '/target', system: false, notify });
    expect(openWorkspaceFile).toHaveBeenLastCalledWith('/target/src/config.ts', '/target');
  });
  it('never replaces a missing historical file with a target namesake', async () => {
    const notify = vi.fn();
    openWorkspaceFile.mockRejectedValueOnce(new Error('File does not exist'));
    await routeAppLink('src/config.ts', { workspace: '/target', sourceCwd: '/old', system: false, notify });
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile).toHaveBeenCalledWith('/old/src/config.ts', '/old');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('File does not exist'));
  });
});
