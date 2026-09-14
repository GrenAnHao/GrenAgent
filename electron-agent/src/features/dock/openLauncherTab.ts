import type { LauncherKind } from './launcherItems';
import {
  defaultTerminalTitle,
  useDockStore,
  type DockRegion,
  type DockTab,
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

function findExisting(region: DockRegion, kind: LauncherKind, workspace?: string): DockTab | undefined {
  return useDockStore.getState().tabs.find((t) => {
    if (t.region !== region || t.kind !== kind) return false;
    if (kind === 'file') return (t.payload as FilePayload).workspace === workspace;
    return true;
  });
}

function uniqueId(canonical: string): string {
  const taken = useDockStore.getState().tabs.some((t) => t.id === canonical);
  return taken ? `${canonical}#${Date.now()}` : canonical;
}

function activateExisting(tab: DockTab, region: DockRegion): void {
  useDockStore.getState().setActive(region, tab.id);
  revealRegion(region);
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
    const existing = findExisting(region, 'file', workspace);
    if (existing) {
      activateExisting(existing, region);
      return;
    }
    const payload: FilePayload = { workspace };
    useDockStore.getState().addTab({
      id: uniqueId(fileTabId(region, workspace)),
      kind: 'file',
      region,
      title: '文件',
      closable: true,
      payload,
    });
    return;
  }

  const existing = findExisting(region, 'review');
  if (existing) {
    activateExisting(existing, region);
    return;
  }
  const payload: ReviewPayload = { workspace };
  useDockStore.getState().addTab({
    id: uniqueId(reviewTabId(region)),
    kind: 'review',
    region,
    title: '审查',
    closable: true,
    payload,
  });
}
