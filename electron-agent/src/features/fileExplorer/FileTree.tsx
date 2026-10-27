import { hotkeysCoreFeature, selectionFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cx } from 'antd-style';
import { Button, Dropdown, Input, type MenuProps } from 'antd';
import { ChevronRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import FileIcon from '../../components/FileIcon';
import type { DirEntry } from '../../lib/files';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { searchTree } from './treeModel';
import type { FileTreeState } from './useFileTree';

/** 条目太多只列了一部分的目录，末尾挂一个不可选的提示节点。 */
const TRUNCATED_KEY_SUFFIX = '\u0000truncated';
const ROW_HEIGHT = 28;

interface NodeData {
  name: string;
  isDir: boolean;
  truncated?: boolean;
}

function highlight(name: string, needle: string): ReactNode {
  if (!needle) return name;
  const at = name.toLowerCase().indexOf(needle);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <span className={styles.match}>{name.slice(at, at + needle.length)}</span>
      {name.slice(at + needle.length)}
    </>
  );
}

/** 右键点中的那一行。 */
export interface TreeMenuTarget {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FileTreeProps {
  tree: FileTreeState;
  selectedPath: string | null;
  onOpen: (path: string) => void;
  /** 鼠标停到某一行时报该行路径。离开行不报 null，由调用方在离开整块面板时清，鼠标移到路径栏上时还能复制那一项。 */
  onHoverPath?: (path: string) => void;
  /** 右键某一行时弹的菜单；不给就没有菜单。菜单项点完自动收起。 */
  contextMenu?: (target: TreeMenuTarget) => MenuProps;
}

/** 文件树：headless-tree 管展开和键盘，浏览器原生滚动；只渲染可视区。展开目录时才列那一层。 */
export function FileTree({ tree, selectedPath, onOpen, onHoverPath, contextMenu }: FileTreeProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const search = useMemo(() => (tree.root ? searchTree(tree.root, tree.dirs, needle) : null), [tree.root, tree.dirs, needle]);
  const searchKey = search ? [...search.expand].sort().join('\0') : '';
  const [storedSearchKey, setStoredSearchKey] = useState(searchKey);
  const [searchExpanded, setSearchExpanded] = useState<string[]>([]);
  if (searchKey !== storedSearchKey) {
    setStoredSearchKey(searchKey);
    setSearchExpanded(search ? [...search.expand] : []);
  }

  if (tree.error) {
    return (
      <div className={styles.center} data-testid="file-tree-error">
        <span>无法列出工作区文件：{tree.error}</span>
        <Button size="small" onClick={tree.reload}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.treeSearch}>
        <Input
          data-testid="file-tree-search"
          size="small"
          allowClear
          variant="filled"
          prefix={<Search size={14} />}
          placeholder="筛选已展开的文件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {search && search.matches === 0 ? <div className={styles.treeHint}>已展开的目录里没有匹配的文件</div> : null}
      <div className={styles.treeBody}>
        {tree.root ? (
          <HeadlessFileTree
            key={tree.root}
            root={tree.root}
            tree={tree}
            needle={search ? needle : ''}
            searchVisible={search?.visible ?? null}
            expandedItems={search ? searchExpanded : tree.expanded}
            onExpandedItems={search ? setSearchExpanded : tree.setExpanded}
            selectedPath={selectedPath}
            onOpen={onOpen}
            onHoverPath={onHoverPath}
            contextMenu={contextMenu}
          />
        ) : (
          <div className={styles.treeHint} data-testid="file-tree-loading">
            加载中…
          </div>
        )}
      </div>
    </>
  );
}

interface HeadlessFileTreeProps {
  root: string;
  tree: FileTreeState;
  needle: string;
  searchVisible: ReadonlySet<string> | null;
  expandedItems: string[];
  onExpandedItems: (ids: string[]) => void;
  selectedPath: string | null;
  onOpen: (path: string) => void;
  onHoverPath?: (path: string) => void;
  contextMenu?: (target: TreeMenuTarget) => MenuProps;
}

function HeadlessFileTree({
  root,
  tree,
  needle,
  searchVisible,
  expandedItems,
  onExpandedItems,
  selectedPath,
  onOpen,
  onHoverPath,
  contextMenu,
}: HeadlessFileTreeProps) {
  // 右键菜单只有一份，挂在鼠标位置的锚点上：行是虚拟化的，菜单开着时滚动会卸掉那一行，不能挂在行上。
  const [menu, setMenu] = useState<(TreeMenuTarget & { x: number; y: number }) | null>(null);
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (!contextMenu) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-row]');
    const path = row?.dataset.path;
    if (!row || !path || row.dataset.truncated === 'true') return;
    event.preventDefault();
    setMenu({ path, name: row.dataset.name ?? path, isDir: row.dataset.dir === 'true', x: event.clientX, y: event.clientY });
  };
  const menuProps = useMemo(() => {
    if (!menu || !contextMenu) return null;
    const built = contextMenu(menu);
    return {
      ...built,
      onClick: (info: Parameters<NonNullable<MenuProps['onClick']>>[0]) => {
        setMenu(null);
        built.onClick?.(info);
      },
    } satisfies MenuProps;
  }, [menu, contextMenu]);
  const dirsRef = useRef(tree.dirs);
  dirsRef.current = tree.dirs;
  const truncatedRef = useRef(tree.truncatedDirs);
  truncatedRef.current = tree.truncatedDirs;
  const visibleRef = useRef(searchVisible);
  visibleRef.current = searchVisible;
  const entries = useMemo(() => {
    const map = new Map<string, DirEntry>();
    for (const listing of tree.dirs.values()) {
      for (const entry of listing) map.set(entry.path, entry);
    }
    return map;
  }, [tree.dirs]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>(null);

  const instance = useTree<NodeData>({
    rootItemId: root,
    indent: 16,
    initialState: { expandedItems, selectedItems: selectedPath ? [selectedPath] : [] },
    state: { expandedItems, selectedItems: selectedPath ? [selectedPath] : [] },
    setExpandedItems: (update) => {
      const next = typeof update === 'function' ? update(expandedItems) : update;
      onExpandedItems(next);
      // 搜索时展开的是已经列过的祖先。平时展开一个还没列过的目录，这时才去列。
      if (visibleRef.current) return;
      for (const id of next) {
        if (id !== root && !dirsRef.current.has(id)) void tree.loadDir(id).catch(() => {});
      }
    },
    // 选中跟着当前打开的文件走，不把点过的目录记成选中。
    setSelectedItems: () => {},
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isDir,
    scrollToItem: (item) => {
      virtualizerRef.current?.scrollToIndex(item.getItemMeta().index, { align: 'auto' });
    },
    onPrimaryAction: (item) => {
      const data = item.getItemData();
      if (!data.truncated && !data.isDir) onOpen(item.getId());
    },
    ignoreHotkeysOnInputs: true,
    dataLoader: {
      getItem: (id) => {
        if (id === root) return { name: '', isDir: true };
        if (id.endsWith(TRUNCATED_KEY_SUFFIX)) return { name: '条目太多，只列出前 5000 个', isDir: false, truncated: true };
        const entry = entriesRef.current.get(id);
        return entry ? { name: entry.name, isDir: entry.isDir } : { name: id.slice(id.lastIndexOf('/') + 1), isDir: false };
      },
      getChildren: (id) => {
        const listing = dirsRef.current.get(id);
        if (!listing) return [];
        const visible = visibleRef.current;
        const ids = listing.map((entry) => entry.path).filter((path) => !visible || visible.has(path));
        if (truncatedRef.current.has(id)) ids.push(`${id}${TRUNCATED_KEY_SUFFIX}`);
        return ids;
      },
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  useEffect(() => {
    instance.rebuildTree();
  }, [instance, tree.dirs, tree.truncatedDirs, searchVisible]);

  const items = instance.getItems();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // 还没量到容器时按 800px 算，jsdom 里高度是 0 也能画出开头几行。
    initialRect: { width: 300, height: 800 },
  });
  virtualizerRef.current = virtualizer;
  const containerProps = instance.getContainerProps('文件');
  const virtualRows = virtualizer.getVirtualItems();
  const rows =
    virtualRows.length > 0
      ? virtualRows
      : items.slice(0, 80).map((_, index) => ({ index, start: index * ROW_HEIGHT, key: index, size: ROW_HEIGHT }));

  return (
    <div
      {...containerProps}
      ref={(el) => {
        scrollRef.current = el;
        containerProps.ref?.(el);
      }}
      className={styles.treeScroll}
      data-testid="file-tree"
      onContextMenu={onContextMenu}
    >
      {menu && menuProps
        ? createPortal(
            <Dropdown
              open
              menu={menuProps}
              trigger={['contextMenu']}
              placement="bottomLeft"
              onOpenChange={(open) => {
                if (!open) setMenu(null);
              }}
            >
              <span
                data-testid="file-tree-menu-anchor"
                style={{ position: 'fixed', left: menu.x, top: menu.y, width: 1, height: 1, pointerEvents: 'none' }}
              />
            </Dropdown>,
            document.body,
          )
        : null}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {rows.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          const props = item.getProps();
          const data = item.getItemData();
          return (
            <div
              {...props}
              key={item.getId()}
              data-index={virtualRow.index}
              data-tree-row=""
              data-path={item.getId()}
              data-name={data.name}
              data-dir={data.isDir ? 'true' : 'false'}
              data-truncated={data.truncated ? 'true' : undefined}
              data-selected={item.isSelected() ? 'true' : undefined}
              data-menu-open={menu?.path === item.getId() ? 'true' : undefined}
              onPointerEnter={() => {
                if (!data.truncated) onHoverPath?.(item.getId());
              }}
              ref={(el) => {
                props.ref?.(el);
              }}
              className={cx(styles.treeRow, item.isSelected() && styles.treeRowSelected)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: ROW_HEIGHT,
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: 4 + item.getItemMeta().level * 16,
              }}
            >
              <span className={styles.treeChevron} data-expanded={item.isFolder() && item.isExpanded() ? 'true' : undefined}>
                {item.isFolder() ? <ChevronRight size={14} /> : null}
              </span>
              {data.truncated ? null : <FileIcon fileName={data.name} isDirectory={data.isDir} size={16} />}
              <span className={cx(styles.treeTitle, data.truncated && styles.truncatedNode)} data-tree-title="">
                {highlight(data.name, needle)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
