import type { LauncherKind } from './launcherItems';
import {
  defaultTerminalTitle,
  useDockStore,
  type DockRegion,
  type FilePayload,
  type ReviewPayload,
} from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

export function fileTabId(region: DockRegion, workspace: string): string {
  return `file:${region}:${workspace}`;
}

export function reviewTabId(region: DockRegion): string {
  return `review:${region}`;
}

function revealRegion(region: DockRegion): void {
  if (region === 'right') useLayoutStore.getState().setRightPanelOpen(true);
  else useLayoutStore.getState().setTerminalOpen(true);
}

function activateExisting(id: string, region: DockRegion): boolean {
  const exists = useDockStore.getState().tabs.some((t) => t.id === id);
  if (!exists) return false;
  useDockStore.getState().setActive(region, id);
  revealRegion(region);
  return true;
}

export function openLauncherTab(input: {
  region: DockRegion;
  kind: LauncherKind;
  workspace?: string;
}): void {
  const { region, kind, workspace } = input;

  if (kind === 'browser') {
    useDockStore.getState().addTab({
      id: `browser-${Date.now()}`,
      kind: 'browser',
      region,
      title: '浏览器',
      closable: true,
      payload: { url: 'https://example.com', title: '浏览器' },
    });
    return;
  }

  if (kind === 'terminal') {
    useDockStore.getState().addTab({
      id: `terminal-${Date.now()}`,
      kind: 'terminal',
      region,
      title: defaultTerminalTitle(),
      closable: true,
      payload: { status: 'idle' },
    });
    return;
  }

  if (kind === 'file') {
    if (!workspace) return;
    const id = fileTabId(region, workspace);
    if (activateExisting(id, region)) return;
    const payload: FilePayload = { workspace };
    useDockStore.getState().addTab({
      id,
      kind: 'file',
      region,
      title: '文件',
      closable: true,
      payload,
    });
    return;
  }

  const id = reviewTabId(region);
  if (activateExisting(id, region)) return;
  const payload: ReviewPayload = { workspace };
  useDockStore.getState().addTab({
    id,
    kind: 'review',
    region,
    title: '审查',
    closable: true,
    payload,
  });
}
