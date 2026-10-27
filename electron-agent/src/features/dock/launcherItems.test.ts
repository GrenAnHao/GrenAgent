import { describe, expect, it } from 'vitest';
import { canOpenLauncherKind, isCasualSession, launcherItems } from './launcherItems';

describe('isCasualSession', () => {
  it('treats missing cwd as casual', () => {
    expect(isCasualSession(null, '/home/.pi/agent/works')).toBe(true);
    expect(isCasualSession('', '/home/.pi/agent/works')).toBe(true);
    expect(isCasualSession(undefined, '/home/.pi/agent/works')).toBe(true);
  });

  it('treats cwd under worksDir as casual', () => {
    expect(isCasualSession('/home/.pi/agent/works/u1', '/home/.pi/agent/works')).toBe(true);
  });

  it('treats a real project cwd as not casual', () => {
    expect(isCasualSession('/repo', '/home/.pi/agent/works')).toBe(false);
  });

  it('treats cwd with unknown worksDir as a project', () => {
    expect(isCasualSession('/repo', '')).toBe(false);
    expect(isCasualSession('/repo', null)).toBe(false);
  });
});

describe('launcherItems', () => {
  it('returns browser, terminal, file for a casual session (no review)', () => {
    const items = launcherItems({
      cwd: '/home/.pi/agent/works/u1',
      worksDir: '/home/.pi/agent/works',
      workspace: '/home/.pi/agent/works/u1',
    });
    expect(items.map((i) => i.kind)).toEqual(['browser', 'terminal', 'file']);
    expect(items.map((i) => i.label)).toEqual(['浏览器', '终端', '文件管理器']);
    expect(items.map((i) => i.shortcut)).toEqual(['Ctrl+T', 'Ctrl+`', 'Ctrl+P']);
    expect(items.find((i) => i.kind === 'file')?.disabled).toBe(false);
  });

  it('disables file for a casual session without a directory', () => {
    const items = launcherItems({ cwd: null, worksDir: '/home/.pi/agent/works', workspace: '' });
    expect(items.find((i) => i.kind === 'file')?.disabled).toBe(true);
  });

  it('returns review, terminal, browser, file for a project session', () => {
    const items = launcherItems({
      cwd: '/repo',
      worksDir: '/home/.pi/agent/works',
      workspace: '/repo',
    });
    expect(items.map((i) => i.kind)).toEqual(['review', 'terminal', 'browser', 'file']);
    expect(items.map((i) => i.label)).toEqual(['审查', '终端', '浏览器', '文件管理器']);
    expect(items.map((i) => i.shortcut)).toEqual(['Ctrl+Shift+G', 'Ctrl+`', 'Ctrl+T', 'Ctrl+P']);
    expect(items.find((i) => i.kind === 'file')?.disabled).toBe(false);
  });

  it('disables file when a project has no workspace', () => {
    const items = launcherItems({ cwd: '/repo', worksDir: '/home/.pi/agent/works', workspace: '' });
    expect(items.map((i) => i.kind)).toEqual(['review', 'terminal', 'browser', 'file']);
    expect(items.find((i) => i.kind === 'file')?.disabled).toBe(true);
  });
});

describe('canOpenLauncherKind', () => {
  const project = { cwd: '/repo', worksDir: '/home/.pi/agent/works', workspace: '/repo' };
  const casual = {
    cwd: '/home/.pi/agent/works/u1',
    worksDir: '/home/.pi/agent/works',
    workspace: '/home/.pi/agent/works/u1',
  };

  it('allows all four kinds in a project with workspace', () => {
    expect(canOpenLauncherKind('review', project)).toBe(true);
    expect(canOpenLauncherKind('file', project)).toBe(true);
    expect(canOpenLauncherKind('browser', project)).toBe(true);
    expect(canOpenLauncherKind('terminal', project)).toBe(true);
  });

  it('ignores review but allows file in a casual session', () => {
    expect(canOpenLauncherKind('review', casual)).toBe(false);
    expect(canOpenLauncherKind('file', casual)).toBe(true);
    expect(canOpenLauncherKind('browser', casual)).toBe(true);
    expect(canOpenLauncherKind('terminal', casual)).toBe(true);
  });

  it('ignores file when workspace is missing', () => {
    expect(canOpenLauncherKind('file', { ...project, workspace: '' })).toBe(false);
    expect(canOpenLauncherKind('review', { ...project, workspace: '' })).toBe(true);
  });
});
