import { isUnder } from '../../lib/pathUtils';

export type LauncherKind = 'review' | 'terminal' | 'browser' | 'file';

export interface LauncherContext {
  cwd?: string | null;
  worksDir?: string | null;
  workspace?: string | null;
}

export interface LauncherItem {
  kind: LauncherKind;
  label: string;
  shortcut: string;
  disabled?: boolean;
}

export function isCasualSession(cwd: string | null | undefined, worksDir: string | null | undefined): boolean {
  if (!cwd) return true;
  return Boolean(worksDir && isUnder(cwd, worksDir));
}

export function launcherItems(ctx: LauncherContext): LauncherItem[] {
  if (isCasualSession(ctx.cwd, ctx.worksDir)) {
    return [
      { kind: 'browser', label: '浏览器', shortcut: 'Ctrl+T' },
      { kind: 'terminal', label: '终端', shortcut: 'Ctrl+`' },
    ];
  }
  return [
    { kind: 'review', label: '审查', shortcut: 'Ctrl+Shift+G' },
    { kind: 'terminal', label: '终端', shortcut: 'Ctrl+`' },
    { kind: 'browser', label: '浏览器', shortcut: 'Ctrl+T' },
    { kind: 'file', label: '文件', shortcut: 'Ctrl+P', disabled: !ctx.workspace },
  ];
}

export function canOpenLauncherKind(kind: LauncherKind, ctx: LauncherContext): boolean {
  if (isCasualSession(ctx.cwd, ctx.worksDir) && (kind === 'file' || kind === 'review')) return false;
  if (kind === 'file' && !ctx.workspace) return false;
  return true;
}
