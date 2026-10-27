import { useCallback, useState } from 'react';
import { FileExplorer } from '../fileExplorer/FileExplorer';
import { sanitizeFileTabs, type FileTabsState } from '../fileExplorer/fileTabsModel';
import { useDockStore, type FilePayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';
import { dockTabStyles } from './dockTabStyles';

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return (a ?? []).length === b.length && b.every((p, i) => a?.[i] === p);
}

/** 「文件管理器」标签：项目文件树 + 多文件标签。 */
export function FileTreeBody({ tab }: DockBodyProps) {
  const payload = tab.payload as FilePayload;
  const workspace = payload.workspace;
  // 打开着的文件标签跟着 dock 标签的 payload 落盘：重启、切回这个会话都按上次的样子恢复。只在挂载时读一次。
  const [initialTabs] = useState(() => sanitizeFileTabs(payload.openFiles, payload.activeFile));
  const tabId = tab.id;
  const onTabsChange = useCallback(
    (tabs: FileTabsState) => {
      const dock = useDockStore.getState();
      const current = dock.tabs.find((t) => t.id === tabId);
      if (!current) return;
      const prev = current.payload as FilePayload;
      if (sameList(prev.openFiles, tabs.paths) && (prev.activeFile ?? null) === tabs.active) return;
      dock.updateTab(tabId, { payload: { ...prev, openFiles: tabs.paths, activeFile: tabs.active } });
    },
    [tabId],
  );
  if (!workspace) {
    return (
      <div className={dockTabStyles.empty} data-testid="file-tree-error">
        没有工作区
      </div>
    );
  }
  return (
    <FileExplorer key={workspace} workspace={workspace} watchId={tab.id} initialTabs={initialTabs} onTabsChange={onTabsChange} />
  );
}
