import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import type { PackageListItem } from '../../../electron/app/piPackageModel';

const { packageList, packageRemove, packageSetEnabled } = vi.hoisted(() => ({
  packageList: vi.fn(),
  packageRemove: vi.fn(),
  packageSetEnabled: vi.fn(),
}));

vi.mock('../../lib/pi', () => ({
  pi: { packageList, packageRemove, packageSetEnabled },
}));

import { PiPackagesPanel } from './PiPackagesPanel';

vi.setConfig({ testTimeout: 45000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const items: PackageListItem[] = [
  { kind: 'builtin', id: 'todo', title: 'todo', scope: 'product', enabled: true, canDisable: false, canRemove: false },
  { kind: 'package', id: 'npm:pi-demo@1.0.0', title: 'pi-demo', scope: 'user', enabled: true, canDisable: true, canRemove: true },
];

function renderPanel(workspace = '/ws') {
  packageList.mockResolvedValue(items);
  return render(
    <ThemeProvider>
      <PiPackagesPanel workspace={workspace} />
    </ThemeProvider>,
  );
}

describe('PiPackagesPanel', () => {
  it('renders builtin rows without an enabled switch and package rows with one', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('package-row-builtin-todo')).toBeTruthy());
    expect(screen.getByTestId('package-row-builtin-todo').textContent).toContain('内置');
    expect(screen.getByTestId('package-row-builtin-todo').querySelector('[data-testid="package-enabled-todo"]')).toBeNull();
    expect(screen.getByTestId('package-row-npm-pi-demo-1.0.0')).toBeTruthy();
    expect(screen.getByTestId('package-enabled-npm-pi-demo-1.0.0')).toBeTruthy();
  });

  it('asks for remove confirmation and does not invoke remove on cancel', async () => {
    packageRemove.mockResolvedValue(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('package-row-npm-pi-demo-1.0.0')).toBeTruthy());
    fireEvent.click(screen.getByTestId('package-remove-npm-pi-demo-1.0.0'));
    expect(screen.getByTestId('package-remove-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('package-remove-cancel'));
    expect(packageRemove).not.toHaveBeenCalled();
  });
});
