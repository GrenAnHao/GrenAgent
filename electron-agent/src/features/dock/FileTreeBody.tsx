import type { FilePayload } from '../../stores/dockStore';
import { FileExplorer } from '../fileExplorer/FileExplorer';
import { dockTabStyles } from './dockTabStyles';
import type { DockBodyProps } from './TabBodyRenderer';

/** 「文件」标签：项目文件浏览器。 */
export function FileTreeBody({ tab }: DockBodyProps) {
  const workspace = (tab.payload as FilePayload).workspace;
  if (!workspace) {
    return (
      <div className={dockTabStyles.empty} data-testid="file-tree-error">
        没有工作区
      </div>
    );
  }
  return <FileExplorer key={workspace} workspace={workspace} watchId={tab.id} />;
}
