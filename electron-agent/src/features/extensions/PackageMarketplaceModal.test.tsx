import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';

const { packageSearch, packageInstall } = vi.hoisted(() => ({
  packageSearch: vi.fn(),
  packageInstall: vi.fn(),
}));

vi.mock('../../lib/pi', () => ({
  pi: { packageSearch, packageInstall },
}));

import { PackageMarketplaceModal } from './PackageMarketplaceModal';

vi.setConfig({ testTimeout: 45000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(workspace = '/ws') {
  packageSearch.mockResolvedValue({
    total: 9908,
    objects: [{ name: 'pi-demo', version: '2.0.0', description: 'd', publisher: 'ada', npmUrl: 'https://www.npmjs.com/package/pi-demo' }],
  });
  return render(
    <ThemeProvider>
      <PackageMarketplaceModal
        open
        workspace={workspace}
        installedNames={['other']}
        onClose={() => {}}
        onInstalled={() => {}}
      />
    </ThemeProvider>,
  );
}

describe('PackageMarketplaceModal', () => {
  it('searches from the input and shows the total count caption', async () => {
    renderModal();
    await waitFor(() => expect(packageSearch).toHaveBeenCalledWith(''));
    fireEvent.change(screen.getByTestId('package-marketplace-search'), { target: { value: 'demo' } });
    fireEvent.keyDown(screen.getByTestId('package-marketplace-search'), { key: 'Enter' });
    await waitFor(() => expect(packageSearch).toHaveBeenCalledWith('demo'));
    expect(screen.getByTestId('package-marketplace-total').textContent).toBe('共 9908 个结果，展示前 20 个');
  });

  it('opens the confirm modal and does not install when cancelled', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByTestId('package-install-pi-demo')).toBeTruthy());
    fireEvent.click(screen.getByTestId('package-install-pi-demo'));
    expect(screen.getByTestId('package-install-confirm')).toBeTruthy();
    expect(screen.getByTestId('package-install-confirm').textContent).toContain('npm:pi-demo@2.0.0');
    expect(screen.getByTestId('package-install-confirm').textContent).toContain('该包将以本机完整权限运行，可执行任意代码。');
    fireEvent.click(screen.getByTestId('package-install-cancel'));
    expect(packageInstall).not.toHaveBeenCalled();
  });
});
