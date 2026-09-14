import { useHotkeys } from 'react-hotkeys-hook';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { canOpenLauncherKind, type LauncherContext, type LauncherKind } from './launcherItems';
import { openLauncherTab } from './openLauncherTab';

export function runDockLauncherHotkey(kind: LauncherKind, ctx: LauncherContext): void {
  if (!canOpenLauncherKind(kind, ctx)) return;
  openLauncherTab({ region: 'right', kind, workspace: ctx.workspace });
}

const HOTKEY_OPTS = { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true };

export function useDockLauncherHotkeys(): void {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const ctx: LauncherContext = { cwd: workspace, worksDir, workspace };

  useHotkeys('ctrl+t,cmd+t', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('browser', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);

  useHotkeys('ctrl+backquote,cmd+backquote', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('terminal', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);

  useHotkeys('ctrl+p,cmd+p', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('file', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);

  useHotkeys('ctrl+shift+g,cmd+shift+g', (e) => {
    e.preventDefault();
    runDockLauncherHotkey('review', ctx);
  }, HOTKEY_OPTS, [workspace, worksDir]);
}
