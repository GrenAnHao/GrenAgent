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
    // 普通对话没有 git 仓库，不给「审查」；文件浏览器按对话自己的目录开，能看 agent 在里面生成的文件。
    return [
      { kind: 'browser', label: '浏览器', shortcut: 'Ctrl+T' },
      { kind: 'terminal', label: '终端', shortcut: 'Ctrl+`' },
      { kind: 'file', label: '文件管理器', shortcut: 'Ctrl+P', disabled: !ctx.workspace },
    ];
  }
  return [
    { kind: 'review', label: '审查', shortcut: 'Ctrl+Shift+G' },
    { kind: 'terminal', label: '终端', shortcut: 'Ctrl+`' },
    { kind: 'browser', label: '浏览器', shortcut: 'Ctrl+T' },
    { kind: 'file', label: '文件管理器', shortcut: 'Ctrl+P', disabled: !ctx.workspace },
  ];
}

export function canOpenLauncherKind(kind: LauncherKind, ctx: LauncherContext): boolean {
  if (isCasualSession(ctx.cwd, ctx.worksDir) && kind === 'review') return false;
  if (kind === 'file' && !ctx.workspace) return false;
  return true;
}
