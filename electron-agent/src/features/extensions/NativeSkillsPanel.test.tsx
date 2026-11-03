import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const { listSkills, importSkillFromDir, importSkillFromFile, installSkillFromZip, openDirectory, openFile } = vi.hoisted(() => ({
  listSkills: vi.fn(),
  importSkillFromDir: vi.fn(),
  importSkillFromFile: vi.fn(),
  installSkillFromZip: vi.fn(),
  openDirectory: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock('../../lib/skillsIo', () => ({
  listSkills,
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  importSkillFromDir,
  importSkillFromFile,
  installSkillFromZip,
  openSkillsDir: vi.fn(),
}));

vi.mock('../../platform/runtime', () => ({
  openDirectory,
  openFile,
}));

import { NativeSkillsPanel } from './NativeSkillsPanel';

vi.setConfig({ testTimeout: 45000 });

// Every case mounts App, so exercise the real message holder instead of setup's no-op.
vi.mocked(App.useApp).mockRestore();

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
  it.each([
    { label: '从 Zip 安装', path: '/fixtures/example.zip', importer: installSkillFromZip, filters: [{ name: 'Zip', extensions: ['zip'] }] },
    { label: '导入单文件 (SKILL.md)', path: '/fixtures/SKILL.md', importer: importSkillFromFile, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] },
    { label: '导入技能目录', path: '/fixtures/skill', importer: importSkillFromDir, filters: undefined },
  ])('uses the correct system picker for $label', async ({ label, path, importer, filters }) => {
    listSkills.mockResolvedValue([]);
    openFile.mockResolvedValue(path);
    openDirectory.mockResolvedValue(path);
    importer.mockResolvedValue({ name: 'imported', path: '/skills/imported/SKILL.md', scope: 'global' });
    renderPanel();
    await screen.findByTestId('skills-empty');
    fireEvent.click(screen.getByTestId('skill-import'));
    fireEvent.click(await screen.findByText(label));
    await waitFor(() => expect(importer).toHaveBeenCalledWith(path));
    if (filters) {
      expect(openFile).toHaveBeenCalledWith({ filters });
      expect(openDirectory).not.toHaveBeenCalled();
    } else {
      expect(openDirectory).toHaveBeenCalledWith();
      expect(openFile).not.toHaveBeenCalled();
    }
  });

  it('shows file picker failures without importing', async () => {
    listSkills.mockResolvedValue([]);
    openFile.mockRejectedValue(new Error('文件选择器不可用'));
    openDirectory.mockResolvedValue(null);
    renderPanel();
    await screen.findByTestId('skills-empty');
    fireEvent.click(screen.getByTestId('skill-import'));
    fireEvent.click(await screen.findByText('从 Zip 安装'));
    expect(await screen.findByText('文件选择器不可用')).toBeInTheDocument();
    expect(installSkillFromZip).not.toHaveBeenCalled();
  });

  it('shows where each skill comes from and filters a long catalog', async () => {
    listSkills.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({
      name: `skill-${i}`, description: i === 3 ? '检查代码规范' : `第 ${i} 个`, path: `/skills/skill-${i}`, scope: 'global',
    })));
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('skill-skill-0')).toBeTruthy());
    expect(screen.getByTestId('skill-source-skill-0')).toHaveTextContent('全局/skills/skill-0');
    expect(screen.getByTestId('skill-skill-0')).not.toHaveTextContent('已启用');
    expect(screen.getByTestId('skill-refresh')).toHaveTextContent('刷新');
    expect(screen.getByTestId('skill-open-dir')).toHaveTextContent('打开目录');
    expect(screen.queryByText('本机技能')).toBeNull();
    fireEvent.change(screen.getByTestId('skill-filter'), { target: { value: '规范' } });
    expect(screen.getByTestId('skill-skill-3')).toBeTruthy();
    expect(screen.queryByTestId('skill-skill-4')).toBeNull();
  });

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
