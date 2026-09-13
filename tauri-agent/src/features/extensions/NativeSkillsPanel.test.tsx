import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const { listSkills } = vi.hoisted(() => ({
  listSkills: vi.fn(),
}));

vi.mock('../../lib/skillsIo', () => ({
  listSkills,
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  importSkillFromDir: vi.fn(),
  importSkillFromFile: vi.fn(),
  installSkillFromZip: vi.fn(),
  openSkillsDir: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

import { NativeSkillsPanel } from './NativeSkillsPanel';

vi.setConfig({ testTimeout: 45000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function renderPanel() {
  return render(
    <ThemeProvider>
      <App>
        <NativeSkillsPanel values={{}} setValue={vi.fn()} onChanged={vi.fn()} />
      </App>
    </ThemeProvider>,
  );
}

describe('NativeSkillsPanel', () => {
  it('renders a skill summary as a single line and can switch catalog views', async () => {
    listSkills.mockResolvedValue([
      {
        name: 'browser',
        description: 'automation\ntasks using\r\n  CDP',
        path: '/skills/browser',
        scope: 'global',
      },
    ]);

    renderPanel();

    await waitFor(() => expect(screen.getByTestId('skill-browser')).toBeTruthy());
    expect(screen.getByTestId('skill-summary-browser').textContent).toBe('automation tasks using CDP');
    expect(screen.getByTestId('skill-catalog').getAttribute('data-view')).toBe('list');

    fireEvent.click(screen.getByTestId('skill-view-grid'));
    expect(screen.getByTestId('skill-catalog').getAttribute('data-view')).toBe('grid');

    fireEvent.click(screen.getByTestId('skill-view-list'));
    expect(screen.getByTestId('skill-catalog').getAttribute('data-view')).toBe('list');
  });
});
