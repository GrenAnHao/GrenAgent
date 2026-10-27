import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { FileViewer } from './FileViewer';
import type { UnsavedChoice } from './unsavedChanges';
import { useOpenFile, type OpenFileApi, type OpenFileState } from './useOpenFile';
import type { ViewerNav } from './ViewerToolbar';

export interface FileTabSummary {
  status: OpenFileState['status'];
  dirty: boolean;
}

export interface FileTabPaneProps {
  workspace: string;
  path: string;
  active: boolean;
  root: string | null;
  isDark: boolean;
  confirm: (fileName: string) => Promise<UnsavedChoice>;
  nav: ViewerNav;
  /** 只给当前标签：查找栏和高亮只出现在看得见的那个文件里。 */
  findScope?: string;
  onOpenLink?: (href: string, options: { system: boolean }) => void;
  /** 每次渲染登记自己最新的 api；卸载时登记 null。 */
  register: (path: string, api: OpenFileApi | null) => void;
  onSummary: (path: string, summary: FileTabSummary | null) => void;
}

/**
 * 一个文件标签：自己持有一份 useOpenFile（内容、未保存修改、编辑模式、磁盘冲突），挂上就读盘。
 * 不是当前标签时只藏起来、不卸载，切回来时撤销历史和滚动位置都在。
 */
export const FileTabPane = memo(function FileTabPane({
  workspace,
  path,
  active,
  root,
  isDark,
  confirm,
  nav,
  findScope,
  onOpenLink,
  register,
  onSummary,
}: FileTabPaneProps) {
  const api = useOpenFile(workspace, confirm);
  const openRef = useRef(api.open);
  openRef.current = api.open;

  useEffect(() => {
    void openRef.current(path);
  }, [path]);

  useLayoutEffect(() => {
    register(path, api);
  });
  useEffect(() => () => register(path, null), [path, register]);

  const { dirty } = api;
  const { status } = api.file;
  useEffect(() => onSummary(path, { status, dirty }), [path, status, dirty, onSummary]);
  useEffect(() => () => onSummary(path, null), [path, onSummary]);

  return (
    <div
      className={styles.tabPane}
      style={active ? undefined : { display: 'none' }}
      data-testid="file-tab-pane"
      data-path={path}
      data-active={active ? 'true' : 'false'}
    >
      <FileViewer workspace={workspace} root={root} api={api} isDark={isDark} onOpenLink={onOpenLink} nav={nav} findScope={findScope} />
    </div>
  );
});
