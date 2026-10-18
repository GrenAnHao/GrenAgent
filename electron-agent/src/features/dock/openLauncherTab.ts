import type { LauncherKind } from './launcherItems';
import {
  currentDockView,
  defaultTerminalTitle,
  isDockTabVisible,
  useDockStore,
  type DockRegion,
  type DockTab,
  type FilePayload,
  type ReviewPayload,
} from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { pathsEquivalent } from '../../lib/pathUtils';

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
  const view = currentDockView();
  return useDockStore.getState().tabs.find((t) => {
    if (t.region !== region || t.kind !== kind) return false;
    // 右栏标签各会话一份：只复用当前会话看得见的，不把别的会话的标签激活到这里。
    if (!isDockTabVisible(t, view)) return false;
    // 同一目录的不同写法（E:\x / E:/x）算同一个标签。
    if (kind === 'file') return !!workspace && pathsEquivalent((t.payload as FilePayload).workspace, workspace);
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

/** 返回激活或新建的标签 id；没开成（缺 workspace）时 undefined。 */
export function openLauncherTab(input: {
  region: DockRegion;
  kind: LauncherKind;
  workspace?: string;
}): string | undefined {
  const { region, kind, workspace } = input;

  if (kind === 'browser') {
    const id = nextBrowserTabId();
    useDockStore.getState().addTab({
      id,
      kind: 'browser',
      region,
      title: '浏览器',
      closable: true,
      payload: { url: 'about:blank', title: '浏览器' },
    });
    return id;
  }

  if (kind === 'terminal') {
    const id = `terminal-${Date.now()}`;
    useDockStore.getState().addTab({
      id,
      kind: 'terminal',
      region,
      title: defaultTerminalTitle(),
      closable: true,
      payload: { status: 'idle' },
    });
    return id;
  }

  if (kind === 'file') {
    if (!workspace) return undefined;
    const existing = findExisting(region, 'file', workspace);
    if (existing) {
      activateExisting(existing, region);
      return existing.id;
    }
    const payload: FilePayload = { workspace };
    const id = uniqueId(fileTabId(region, workspace));
    useDockStore.getState().addTab({
      id,
      kind: 'file',
      region,
      title: '文件',
      closable: true,
      payload,
    });
    return id;
  }

  const existing = findExisting(region, 'review');
  if (existing) {
    const prev = existing.payload as ReviewPayload;
    useDockStore.getState().updateTab(existing.id, {
      payload: { workspace: workspace ?? prev.workspace },
    });
    activateExisting(existing, region);
    return existing.id;
  }
  const payload: ReviewPayload = { workspace };
  const id = uniqueId(reviewTabId(region));
  useDockStore.getState().addTab({
    id,
    kind: 'review',
    region,
    title: '审查',
    closable: true,
    payload,
  });
  return id;
}

export function openTurnReview(input: { turnId: string; fileIndex: number; workspace?: string }): void {
  const region = 'right';
  const payload: ReviewPayload = {
    workspace: input.workspace,
    turnId: input.turnId,
    fileIndex: input.fileIndex,
  };
  const view = currentDockView();
  const existing = useDockStore
    .getState()
    .tabs.find((t) => t.region === region && t.kind === 'review' && isDockTabVisible(t, view));
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
