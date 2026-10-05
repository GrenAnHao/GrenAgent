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

let tabNonce = 0;

function uniqueId(canonical: string): string {
  const tabs = useDockStore.getState().tabs;
  if (!tabs.some((t) => t.id === canonical)) return canonical;
  tabNonce += 1;
  return uniqueId(`${canonical}#${tabNonce}`);
}

function isBrowserIdTaken(id: string): boolean {
  const { tabs, closedTabs } = useDockStore.getState();
  return tabs.some((t) => t.id === id) || closedTabs.some((c) => c.id === id);
}

export function nextBrowserTabId(): string {
  let id: string;
  do {
    tabNonce += 1;
    id = `browser:${tabNonce}`;
  } while (isBrowserIdTaken(id));
  return id;
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
      id: nextBrowserTabId(),
      kind: 'browser',
      region,
      title: '浏览器',
      closable: true,
      payload: { url: 'about:blank', title: '浏览器' },
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
    const prev = existing.payload as ReviewPayload;
    useDockStore.getState().updateTab(existing.id, {
      payload: { workspace: workspace ?? prev.workspace },
    });
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

export function openTurnReview(input: { turnId: string; fileIndex: number; workspace?: string }): void {
  const region = 'right';
  const payload: ReviewPayload = {
    workspace: input.workspace,
    turnId: input.turnId,
    fileIndex: input.fileIndex,
  };
  const existing = useDockStore.getState().tabs.find((t) => t.region === region && t.kind === 'review');
  if (existing) {
    useDockStore.getState().updateTab(existing.id, { payload });
    useDockStore.getState().setActive(region, existing.id);
    useLayoutStore.getState().setRightPanelOpen(true);
    return;
  }
  useDockStore.getState().addTab({
    id: uniqueId(reviewTabId(region)),
    kind: 'review',
    region,
    title: '审查',
    closable: true,
    payload,
  });
}
