import { Dropdown, type MenuProps } from 'antd';
import { X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, type MouseEvent, type WheelEvent } from 'react';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { fileTabLabels, type CloseScope } from './fileTabsModel';
import { relativeSegments } from './treeModel';

export interface FileTabBarProps {
  /** 项目根（realpath 后）；悬停提示写相对它的路径。 */
  root: string | null;
  paths: string[];
  active: string | null;
  dirty: ReadonlySet<string>;
  onActivate: (path: string) => void;
  onClose: (path: string, scope: CloseScope) => void;
}

/** 文件管理器内容区顶上的文件标签栏。标签多了横向滚动（滚轮也能横着滚），当前标签总是滚进可视区。 */
export const FileTabBar = memo(function FileTabBar({ root, paths, active, dirty, onActivate, onClose }: FileTabBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const labels = useMemo(() => fileTabLabels(paths), [paths]);

  // 只在当前标签换了时滚：用户把标签栏滚到别处、中键关掉那里的标签，不该被拉回当前标签。
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !active || scrolledFor.current === active) return;
    scrolledFor.current = active;
    const tab = [...bar.querySelectorAll<HTMLElement>('[data-file-tab]')].find((el) => el.dataset.path === active);
    if (!tab) return;
    // 只动标签栏自己的横向滚动，不用 scrollIntoView（它会连外层面板一起滚）。
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < bar.scrollLeft) bar.scrollLeft = left;
    else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
  }, [active, paths]);

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar || event.deltaX !== 0 || event.deltaY === 0) return;
    bar.scrollLeft += event.deltaY;
  };

  if (paths.length === 0) return null;

  return (
    <div ref={barRef} className={styles.tabBar} role="tablist" aria-label="打开的文件" data-testid="file-tabs" onWheel={onWheel}>
      {paths.map((path, index) => {
        const { name, hint } = labels[index];
        const isActive = path === active;
        const isDirty = dirty.has(path);
        const rel = root ? relativeSegments(root, path) : null;
        const title = rel ? rel.join('/') || name : path;
        const menu: MenuProps = {
          items: [
            { key: 'self', label: '关闭' },
            { key: 'others', label: '关闭其他', disabled: paths.length < 2 },
            { key: 'right', label: '关闭右侧', disabled: index === paths.length - 1 },
            { type: 'divider' },
            { key: 'all', label: '全部关闭' },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            onClose(path, key as CloseScope);
          },
        };
        const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
          // 中键按下默认是自动滚动，拦掉；关闭在 auxclick 里做。
          if (event.button === 1) event.preventDefault();
        };
        const onAuxClick = (event: MouseEvent<HTMLDivElement>) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(path, 'self');
        };
        return (
          <Dropdown key={path} menu={menu} trigger={['contextMenu']}>
            <div
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              className={styles.tab}
              title={title}
              data-file-tab=""
              data-testid="file-tab"
              data-path={path}
              data-active={isActive ? 'true' : 'false'}
              data-dirty={isDirty ? 'true' : 'false'}
              onClick={() => onActivate(path)}
              onMouseDown={onMouseDown}
              onAuxClick={onAuxClick}
            >
              <span className={styles.tabName} data-testid="file-tab-name">
                {name}
              </span>
              {hint ? (
                <span className={styles.tabHint} data-testid="file-tab-hint">
                  {hint}
                </span>
              ) : null}
              <button
                type="button"
                className={styles.tabClose}
                data-testid="file-tab-close"
                aria-label={`关闭 ${name}`}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(path, 'self');
                }}
              >
                {isDirty ? <span className={styles.tabDirtyDot} data-testid="file-tab-dirty" /> : null}
                <X size={12} className={styles.tabCloseIcon} />
              </button>
            </div>
          </Dropdown>
        );
      })}
    </div>
  );
});
